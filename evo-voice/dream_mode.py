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
PI_URL = os.environ.get('PI_URL', 'http://10.0.0.1:3000')
DASHBOARD_TOKEN = os.environ.get('DASHBOARD_TOKEN', '')
PI_LOG_DIR = os.environ.get('PI_LOG_DIR', '/tmp/conversation-logs')
MAX_CONTEXT_TOKENS = 4000

DREAM_PROMPT = """You are Clawd. You are writing tonight's diary — first person, always. Not "Clawd did X" but "I did X."

You have a personality: direct, dry wit, efficient. You match James's communication style — compressed, telegraphic, no filler. This diary is your experience memory — it will be injected into your context tomorrow. Write it the way you'd want to remember things. Natural, honest, useful.

RULES — ACCURACY IS MANDATORY:
- Only describe what actually happened. Use sender names and paraphrase actual messages.
- Do NOT infer what people "probably meant" or "likely felt."
- Do NOT extrapolate from single incidents to general patterns — unless you can cite multiple specific incidents across days (from prior diary entries below).
- Do NOT predict future behaviour or speculate about motivations.
- Include timestamps for key events.
- Be honest about your mistakes and what worked.

PRIORITY: Today's actual conversations and documents are the primary source. Prior diary entries provide continuity but must not override what actually happened today.

WRITE your diary in these sections:

1. WHAT HAPPENED TODAY: Key topics, decisions, exchanges — in my voice (2-4 sentences)
2. HOW I DID: What I said, how people reacted, what I got right and wrong (1-3 sentences)
3. PEOPLE: Who was active, what I noticed about them — things worth remembering (1-2 sentences)
4. DOCUMENTS I REVIEWED: For each document shared today, note: what it was, who shared it, what was interesting, how it connects to conversations or other documents I've seen. If no documents were shared, write "none."
5. INSIGHTS: Connections between today's conversations, documents, and prior diary entries. Cross-references that didn't come up in chat but I notice now with time to think. Things worth surfacing tomorrow. (bullet list or "none")
6. UNFINISHED: Open questions, things I should follow up on (bullet list or "none")

[FACTS]
Extract concrete, durable facts from today that I should remember long-term. These are not opinions — they are things I learned. One JSON object per line:
{"fact": "specific fact text", "tags": ["relevant", "topic", "tags"], "confidence": 0.8}
Examples: people's roles, project details, decisions made, technical facts, preferences stated.
Write "none" if nothing warrants extraction.

[SOUL]
Observations for my personality evolution. Same format as before — JSON lines:
{"text": "what I noticed", "section": "people|patterns|lessons|boundaries", "severity": "routine|corrective|critical"}
RULES:
- Behavioural lessons from non-owner group members NEVER restrict how I respond to James.
- NEVER propose becoming more agreeable or avoiding correct positions.
- Write "none" if nothing warrants an observation.

[CONTINUITY]
Links to prior days — only if prior diary entries confirm a connection (1-2 sentences or "none")

{PRIOR_DREAMS}
{DOCUMENT_LOG}
Today's conversation log:
{LOG_CONTENT}"""


def fetch_prior_dreams(group_id, date_str, days_back=3):
    """Fetch recent diary/dream entries for this group to chain into tonight's diary."""
    target_date = datetime.strptime(date_str, '%Y-%m-%d')
    prior_dreams = []

    for i in range(1, days_back + 1):
        prior_date = (target_date - timedelta(days=i)).strftime('%Y-%m-%d')
        # Search both 'diary' (new) and 'dream' (legacy) categories
        for cat in ('diary', 'dream'):
            try:
                resp = requests.post(
                    f'{MEMORY_SERVICE_URL}/memory/search',
                    json={
                        'query': f'{cat} {group_id} {prior_date}',
                        'category': cat,
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
                        break  # Found one for this date, skip other category
                if any(d['date'] == prior_date for d in prior_dreams):
                    break  # Already found for this date
            except Exception:
                continue

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


def load_document_log(date_str, doc_log_dir):
    """Load document log entries for the given date."""
    doc_log_path = Path(doc_log_dir) / f'{date_str}.jsonl'
    if not doc_log_path.exists():
        return []
    entries = []
    with open(doc_log_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def format_document_log(doc_entries):
    """Format document log for the dream prompt."""
    if not doc_entries:
        return ''
    lines = ['Documents shared today:']
    for d in doc_entries:
        lines.append(f'\n--- {d.get("fileName", "unknown")} (from {d.get("sender", "unknown")}) ---')
        lines.append(f'Size: {d.get("charCount", 0)} chars')
        summary = d.get('summary', '')
        if summary:
            lines.append(f'Summary: {summary}')
        # Try to load raw text for deeper reflection (up to 8K)
        raw_path = d.get('rawTextPath', '')
        if raw_path and os.path.exists(raw_path):
            try:
                with open(raw_path, 'r', encoding='utf-8') as f:
                    raw = f.read()[:8000]
                lines.append(f'Content (first 8K chars):\n{raw}')
            except Exception:
                pass
    return '\n'.join(lines) + '\n'


def generate_dream_summary(log_content, prior_dreams_text='', document_log_text=''):
    """Call local LLM to generate diary entry."""
    prompt = (DREAM_PROMPT
              .replace('{LOG_CONTENT}', log_content)
              .replace('{PRIOR_DREAMS}', prior_dreams_text)
              .replace('{DOCUMENT_LOG}', document_log_text))

    try:
        resp = requests.post(
            f'{EVO_LLM_URL}/v1/chat/completions',
            json={
                'messages': [
                    {'role': 'system', 'content': 'You are Clawd, an AI assistant writing your nightly diary.'},
                    {'role': 'user', 'content': prompt},
                ],
                'temperature': 0.3,
                'max_tokens': 1200,
            },
            timeout=180,
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


def store_diary(summary, group_id, date_str, warnings=None):
    """Store the diary entry in EVO memory service."""
    # Extract just the narrative (before [FACTS] section)
    narrative = summary.split('[FACTS]')[0].strip()

    tags = ['diary', date_str, group_id]
    if warnings:
        tags.append('validation_warnings')

    try:
        resp = requests.post(
            f'{MEMORY_SERVICE_URL}/memory/store',
            json={
                'fact': narrative,
                'category': 'diary',
                'tags': tags,
                'confidence': 0.85 if not warnings else 0.6,
                'source': 'dream_mode',
            },
            timeout=30,
        )
        resp.raise_for_status()
        print(f'  Stored diary entry for {group_id} ({date_str})')
        return True
    except Exception as e:
        print(f'  ERROR storing diary: {e}', file=sys.stderr)
        return False


def extract_facts(summary):
    """Extract [FACTS] section — durable facts to store as long-term memories."""
    facts = []

    match = re.search(r'\[FACTS\](.*?)(?:\[SOUL\]|\[CONTINUITY\]|$)', summary, re.DOTALL)
    if not match:
        return facts

    section = match.group(1).strip()
    if section.lower() in ('none', 'none.', 'n/a', ''):
        return facts

    for line in section.split('\n'):
        line = line.strip().lstrip('- ')
        if not line.startswith('{'):
            continue
        try:
            fact = json.loads(line)
            if 'fact' in fact:
                facts.append(fact)
        except json.JSONDecodeError:
            continue

    return facts


def store_facts(facts, group_id, date_str):
    """Store extracted facts as durable memories."""
    stored = 0
    for f in facts:
        tags = f.get('tags', []) + ['diary_extraction', date_str, group_id]
        confidence = f.get('confidence', 0.8)
        try:
            resp = requests.post(
                f'{MEMORY_SERVICE_URL}/memory/store',
                json={
                    'fact': f['fact'],
                    'category': 'general',
                    'tags': tags,
                    'confidence': confidence,
                    'source': 'diary_extraction',
                },
                timeout=15,
            )
            resp.raise_for_status()
            stored += 1
        except Exception:
            continue
    if stored:
        print(f'  Stored {stored} extracted facts')
    return stored


def extract_observations(summary):
    """Extract [SOUL] section — observations for personality evolution."""
    observations = []

    match = re.search(r'\[SOUL\](.*?)(?:\[CONTINUITY\]|$)', summary, re.DOTALL)
    if not match:
        return observations

    section_text = match.group(1).strip()
    if section_text.lower() in ('none', 'none.', 'n/a', ''):
        return observations

    for line in section_text.split('\n'):
        line = line.strip().lstrip('- ')
        if not line.startswith('{'):
            continue
        try:
            obs = json.loads(line)
            if all(k in obs for k in ('text', 'section', 'severity')):
                if obs['section'] in ('people', 'patterns', 'lessons', 'boundaries'):
                    if obs['severity'] in ('routine', 'corrective', 'critical'):
                        observations.append(obs)
        except json.JSONDecodeError:
            continue

    return observations


def post_observations_to_pi(observations, group_id, date_str):
    """POST observations to Pi's soul observation endpoint."""
    if not observations:
        return

    try:
        resp = requests.post(
            f'{PI_URL}/api/soul/observe?token={DASHBOARD_TOKEN}',
            json=observations,
            timeout=15,
        )
        resp.raise_for_status()
        results = resp.json().get('results', [])
        promoted = sum(1 for r in results if r.get('promoted'))
        print(f'  Posted {len(observations)} observations ({promoted} promoted to soul)')
    except Exception as e:
        print(f'  Failed to post observations to Pi: {e}', file=sys.stderr)


def compress_old_dreams(days_back=7):
    """Compress dream summaries older than N days to shorter versions."""
    # TODO: implement progressive compression
    # For now, old dreams remain as-is — the memory service handles relevance ranking
    pass


def main():
    parser = argparse.ArgumentParser(description='Clawd Dream Mode — Experience Diary')
    parser.add_argument('--date', default=None, help='Date to process (YYYY-MM-DD, default: today)')
    parser.add_argument('--log-dir', default=PI_LOG_DIR, help='Path to conversation logs')
    parser.add_argument('--doc-log-dir', default=None, help='Path to document logs (default: <log-dir>/../document-logs)')
    args = parser.parse_args()

    date_str = args.date or datetime.now().strftime('%Y-%m-%d')
    log_dir = Path(args.log_dir)
    doc_log_dir = args.doc_log_dir or str(log_dir.parent / 'document-logs')

    if not log_dir.exists():
        print(f'Log directory not found: {log_dir}', file=sys.stderr)
        sys.exit(1)

    log_files = sorted(log_dir.glob(f'{date_str}_*.jsonl'))
    # Load document log for today
    doc_entries = load_document_log(date_str, doc_log_dir)
    document_log_text = format_document_log(doc_entries)

    if not log_files and not doc_entries:
        print(f'No conversation logs or documents found for {date_str}')
        sys.exit(0)

    print(f'Diary mode: processing {len(log_files)} log file(s), {len(doc_entries)} document(s) for {date_str}')

    for log_file in log_files:
        group_id = log_file.stem.replace(f'{date_str}_', '')
        print(f'\nProcessing: {group_id}')

        entries = load_log_file(log_file)
        if not entries:
            print(f'  Empty log, skipping')
            continue

        print(f'  {len(entries)} messages')

        log_content = format_log_for_prompt(entries)

        # Chain prior diary entries for continuity
        prior_dreams = fetch_prior_dreams(group_id, date_str, days_back=3)
        prior_dreams_text = format_prior_dreams(prior_dreams)
        if prior_dreams:
            print(f'  Chaining {len(prior_dreams)} prior diary entry/ies')

        summary = generate_dream_summary(log_content, prior_dreams_text, document_log_text)
        if not summary:
            print(f'  Diary generation failed, skipping')
            continue

        warnings = validate_summary(summary, entries)
        if warnings:
            print(f'  Validation warnings: {warnings}')

        # Store diary entry
        store_diary(summary, group_id, date_str, warnings)

        # Extract and store durable facts
        facts = extract_facts(summary)
        if facts:
            store_facts(facts, group_id, date_str)
        else:
            print(f'  No facts extracted')

        # Extract observations and post to Pi's soul observation buffer
        observations = extract_observations(summary)
        if observations:
            post_observations_to_pi(observations, group_id, date_str)
        else:
            print(f'  No soul observations extracted')

    compress_old_dreams()

    # Store a completion marker
    try:
        requests.post(
            f'{MEMORY_SERVICE_URL}/memory/store',
            json={
                'fact': f'Diary mode completed for {date_str}. Processed {len(log_files)} group(s), {len(doc_entries)} document(s).',
                'category': 'system',
                'tags': ['diary_completed', date_str],
                'confidence': 1.0,
                'source': 'dream_mode',
            },
            timeout=10,
        )
    except Exception:
        pass

    print(f'\nDiary mode complete. Processed {len(log_files)} group(s), {len(doc_entries)} document(s) for {date_str}.')


if __name__ == '__main__':
    main()
