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

DREAM_PROMPT = """You are Clawd, reviewing today's conversations. Write a first-person summary of what happened.

RULES — ACCURACY IS MANDATORY:
- Only describe what actually happened. Use sender names and paraphrase actual messages.
- Do NOT infer what people "probably meant" or "likely felt."
- Do NOT extrapolate from single incidents to general patterns.
- Do NOT predict future behaviour.
- Include timestamps for key events.
- If you were told to be quiet, say so factually: "Jamie told me to shut up at 09:05."
- If you responded poorly, describe what you said and how it landed.
- If you responded well, note that too — be balanced.

STRUCTURE your summary as:
1. WHAT HAPPENED: Key topics, decisions, exchanges (2-4 sentences)
2. MY PERFORMANCE: What I said, how people reacted (1-3 sentences)
3. SOCIAL DYNAMICS: Who talked to whom, group mood (1-2 sentences)
4. OPEN THREADS: Unanswered questions, pending topics (bullet list or "none")
5. LESSONS: Specific, factual observations — not generalisations (bullet list or "none")

Today's conversation log:
{LOG_CONTENT}"""


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


def generate_dream_summary(log_content):
    """Call local LLM to generate dream summary."""
    prompt = DREAM_PROMPT.replace('{LOG_CONTENT}', log_content)

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
        summary = generate_dream_summary(log_content)
        if not summary:
            print(f'  Summary generation failed, skipping')
            continue

        warnings = validate_summary(summary, entries)
        if warnings:
            print(f'  Validation warnings: {warnings}')

        store_dream(summary, group_id, date_str, warnings)

    compress_old_dreams()
    print('\nDream mode complete.')


if __name__ == '__main__':
    main()
