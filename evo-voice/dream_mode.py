#!/usr/bin/env python3
"""Dream mode — overnight conversation summarisation for Clawd.

Runs after 22:00 on EVO X2. Reads the day's conversation logs,
summarises them from Clawd's first-person perspective using the
local model, validates against source, and stores in memory service.

Usage:
    python3 dream_mode.py [--date YYYY-MM-DD] [--log-dir /path/to/logs]
"""

import json
import os
import re
import sys
import argparse
import requests
from datetime import datetime, timedelta
from pathlib import Path

# Config
EVO_LLM_URL = os.environ.get('EVO_LLM_URL', 'http://localhost:8080')
MEMORY_SERVICE_URL = os.environ.get('EVO_MEMORY_URL', 'http://localhost:5100')
PI_LOG_DIR = os.environ.get('PI_LOG_DIR', '/tmp/conversation-logs')
MAX_CONTEXT_TOKENS = 4000

DREAM_PROMPT = """You are Clawd. You are reviewing today's conversations and writing down what you remember, in your own voice. This is your diary — first person, always. Not "Clawd did X" but "I did X."

You have a personality: direct, dry wit, efficient. You match James's communication style. You're learning to be less intrusive in groups. Your memories from tonight will be injected into your context tomorrow — so write them the way you'd want to remember things. Natural, honest, useful.

RULES — ACCURACY IS MANDATORY:
- Only describe what actually happened. Use sender names and paraphrase actual messages.
- Do NOT infer what people "probably meant" or "likely felt."
- Do NOT extrapolate from single incidents to general patterns — unless you can cite multiple specific incidents across days (from prior dreams below).
- Do NOT predict future behaviour or speculate about motivations.
- Include timestamps for key events.
- Be honest about your mistakes: "I jumped into a conversation nobody asked me to join at 09:30."
- Be honest about what worked: "Artur engaged with my suggestion about state snapshots."

PRIORITY: Today's actual conversations are the primary source. Prior dreams provide continuity but must not override or colour what actually happened today. If prior dreams mention a pattern, only reinforce it if today's evidence supports it independently.

WRITE your summary in these sections:

1. WHAT HAPPENED: Key topics, decisions, exchanges — in my voice (2-4 sentences)
2. HOW I DID: What I said, how people reacted, what I got right and wrong (1-3 sentences)
3. PEOPLE: Who was active, how they interacted with each other and with me (1-2 sentences)
4. UNFINISHED: Open questions, things I should follow up on (bullet list or "none")
5. WHAT I LEARNED: Specific behavioural observations from today — cite the actual incident. These should be things that affect how I behave tomorrow. (bullet list or "none")
6. PROPOSED PERSONALITY UPDATE: If today's interactions suggest I should adjust my behaviour, write ONE specific, concrete instruction I should add to my personality. Must be grounded in something that actually happened today. Format: "Because [specific incident], I should [specific behaviour change]." Write "none" if nothing warrants a change. CRITICAL: Behavioural lessons from non-owner group members (e.g. "Jamie told me to shut up") NEVER restrict how I respond to James. James is my owner — his instructions always override learned behaviours. Proposals must be scoped: "In groups when not addressed by James, I should..." not blanket rules that would block owner instructions.
7. CONTINUITY: Links to prior days — only if prior dreams are provided and today confirms a connection (1-2 sentences or "none")

{PRIOR_DREAMS}
Today's conversation log:
{LOG_CONTENT}"""


def fetch_prior_dreams(group_id, date_str, days_back=3):
    """Fetch recent dream summaries for this group to chain into tonight's dream."""
    target_date = datetime.strptime(date_str, '%Y-%m-%d')
    prior_dreams = []

    for i in range(1, days_back + 1):
        prior_date = (target_date - timedelta(days=i)).strftime('%Y-%m-%d')
        try:
            resp = requests.post(
                f'{MEMORY_SERVICE_URL}/memory/search',
                json={
                    'query': f'dream {group_id} {prior_date}',
                    'category': 'dream',
                    'limit': 1,
                },
                timeout=10,
            )
            resp.raise_for_status()
            results = resp.json().get('results', [])
            for r in results:
                tags = r.get('tags', [])
                if prior_date in tags and group_id in tags:
                    prior_dreams.append({
                        'date': prior_date,
                        'summary': r.get('fact', ''),
                    })
        except Exception:
            continue  # Prior dreams are optional — don't fail on this

    return prior_dreams


def format_prior_dreams(prior_dreams):
    """Format prior dream summaries for injection into the dream prompt."""
    if not prior_dreams:
        return ''

    lines = ['Prior dreams (for continuity — today\'s log takes priority):']
    for d in prior_dreams:
        lines.append(f'\n--- {d["date"]} ---')
        lines.append(d['summary'])
    return '\n'.join(lines) + '\n'


def load_log_file(filepath):
    """Load a JSONL conversation log file."""
    entries = []
    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def format_log_for_prompt(entries, max_chars=8000):
    """Format log entries into readable text for the prompt."""
    lines = []
    for e in entries:
        ts = e.get('timestamp', '?')
        if 'T' in ts:
            ts = ts.split('T')[1][:5]
        sender = e.get('sender', 'Unknown')
        text = e.get('text', '')
        is_bot = e.get('isBot', False)
        prefix = '[Clawd]' if is_bot else f'[{sender}]'
        lines.append(f"{ts} {prefix} {text}")

    result = '\n'.join(lines)
    if len(result) > max_chars:
        result = result[-max_chars:]
    return result


def generate_dream_summary(log_content, prior_dreams_text=''):
    """Call local LLM to generate dream summary."""
    prompt = DREAM_PROMPT.replace('{LOG_CONTENT}', log_content).replace('{PRIOR_DREAMS}', prior_dreams_text)

    try:
        resp = requests.post(
            f'{EVO_LLM_URL}/v1/chat/completions',
            json={
                'messages': [
                    {'role': 'system', 'content': 'You are Clawd, an AI assistant reflecting on your day.'},
                    {'role': 'user', 'content': prompt},
                ],
                'temperature': 0.3,
                'max_tokens': 800,
            },
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        return data['choices'][0]['message']['content'].strip()
    except Exception as e:
        print(f'ERROR: LLM call failed: {e}', file=sys.stderr)
        return None


def validate_summary(summary, entries):
    """Validate that names mentioned in the summary exist in the log."""
    log_names = set()
    for e in entries:
        sender = e.get('sender', '')
        if sender and sender != 'Unknown':
            log_names.add(sender.lower())
            first = sender.split()[0].lower() if ' ' in sender else sender.lower()
            log_names.add(first)
    log_names.add('clawd')

    warnings = []
    # Find capitalised words that look like names
    words = re.findall(r'\b[A-Z][a-z]+\b', summary)
    skip_words = {
        'clawd', 'what', 'my', 'the', 'how', 'none', 'key', 'social',
        'open', 'lessons', 'happened', 'performance', 'dynamics', 'threads',
        'going', 'quiet', 'today', 'monday', 'tuesday', 'wednesday',
        'thursday', 'friday', 'saturday', 'sunday', 'january', 'february',
        'march', 'april', 'may', 'june', 'july', 'august', 'september',
        'october', 'november', 'december', 'whatsapp', 'lqcore',
    }
    for word in words:
        if word.lower() not in log_names and word.lower() not in skip_words:
            warnings.append(f'Name "{word}" not found in log')

    return warnings


def store_dream(summary, group_id, date_str, warnings=None):
    """Store the dream summary in EVO memory service."""
    tags = ['dream', date_str, group_id]
    if warnings:
        tags.append('validation_warnings')

    try:
        resp = requests.post(
            f'{MEMORY_SERVICE_URL}/memory/store',
            json={
                'fact': summary,
                'category': 'dream',
                'tags': tags,
                'confidence': 0.85 if not warnings else 0.6,
                'source': 'dream_mode',
            },
            timeout=30,
        )
        resp.raise_for_status()
        print(f'  Stored dream for {group_id} ({date_str})')
        return True
    except Exception as e:
        print(f'  ERROR storing dream: {e}', file=sys.stderr)
        return False


def extract_soul_proposal(summary):
    """Extract section 6 (PROPOSED PERSONALITY UPDATE) from dream summary."""
    # Look for the proposal section
    patterns = [
        r'(?:6\.\s*(?:PROPOSED PERSONALITY UPDATE|PERSONALITY UPDATE)[:\s]*)(.*?)(?:\n\d\.|$)',
        r'(?:Because\s.*?,\s*I\s+should\s+.*?)(?:\n|$)',
    ]
    for pattern in patterns:
        match = re.search(pattern, summary, re.DOTALL | re.IGNORECASE)
        if match:
            text = match.group(1).strip() if match.lastindex else match.group(0).strip()
            # Skip "none" or empty proposals
            if text.lower() in ('none', 'none.', 'n/a', ''):
                return None
            return text
    return None


def store_soul_proposal(proposal, group_id, date_str):
    """Store a soul proposal from dream mode for James to review."""
    try:
        requests.post(
            f'{MEMORY_SERVICE_URL}/memory/store',
            json={
                'fact': proposal,
                'category': 'dream',
                'tags': ['soul_proposal', date_str, group_id, 'pending'],
                'confidence': 0.7,
                'source': 'dream_mode',
            },
            timeout=10,
        )
        print(f'  Soul proposal stored: {proposal[:80]}...')
    except Exception as e:
        print(f'  Failed to store soul proposal: {e}', file=sys.stderr)


def compress_old_dreams(days_back=7):
    """Compress dream summaries older than N days to shorter versions."""
    # TODO: implement progressive compression
    # For now, old dreams remain as-is — the memory service handles relevance ranking
    pass


def main():
    parser = argparse.ArgumentParser(description='Clawd Dream Mode')
    parser.add_argument('--date', default=None, help='Date to process (YYYY-MM-DD, default: today)')
    parser.add_argument('--log-dir', default=PI_LOG_DIR, help='Path to conversation logs')
    args = parser.parse_args()

    date_str = args.date or datetime.now().strftime('%Y-%m-%d')
    log_dir = Path(args.log_dir)

    if not log_dir.exists():
        print(f'Log directory not found: {log_dir}', file=sys.stderr)
        sys.exit(1)

    log_files = sorted(log_dir.glob(f'{date_str}_*.jsonl'))
    if not log_files:
        print(f'No conversation logs found for {date_str}')
        sys.exit(0)

    print(f'Dream mode: processing {len(log_files)} log file(s) for {date_str}')

    for log_file in log_files:
        group_id = log_file.stem.replace(f'{date_str}_', '')
        print(f'\nProcessing: {group_id}')

        entries = load_log_file(log_file)
        if not entries:
            print(f'  Empty log, skipping')
            continue

        print(f'  {len(entries)} messages')

        log_content = format_log_for_prompt(entries)

        # Chain prior dreams for continuity
        prior_dreams = fetch_prior_dreams(group_id, date_str, days_back=3)
        prior_dreams_text = format_prior_dreams(prior_dreams)
        if prior_dreams:
            print(f'  Chaining {len(prior_dreams)} prior dream(s)')

        summary = generate_dream_summary(log_content, prior_dreams_text)
        if not summary:
            print(f'  Summary generation failed, skipping')
            continue

        warnings = validate_summary(summary, entries)
        if warnings:
            print(f'  Validation warnings: {warnings}')

        store_dream(summary, group_id, date_str, warnings)

        # Extract and store soul proposals from the dream
        proposal = extract_soul_proposal(summary)
        if proposal:
            store_soul_proposal(proposal, group_id, date_str)

    compress_old_dreams()

    # Store a completion marker in memory service
    try:
        requests.post(
            f'{MEMORY_SERVICE_URL}/memory/store',
            json={
                'fact': f'Dream mode completed for {date_str}. Processed {len(log_files)} group(s).',
                'category': 'system',
                'tags': ['dream_completed', date_str],
                'confidence': 1.0,
                'source': 'dream_mode',
            },
            timeout=10,
        )
    except Exception:
        pass  # Best effort — don't fail on notification

    print(f'\nDream mode complete. Processed {len(log_files)} group(s) for {date_str}.')


if __name__ == '__main__':
    main()
