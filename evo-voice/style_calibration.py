#!/usr/bin/env python3
"""Weekly style calibration — reviews James's recent messages and proposes
voice profile updates if his communication style has shifted.

Runs on EVO X2 via systemd timer (weekly). Reads conversation logs from
the past 7 days, extracts James's messages, compares against the current
voice profile in memory, and proposes updates if warranted.

Usage:
    python3 style_calibration.py [--days 7] [--log-dir /tmp/conversation-logs]
"""

import json
import os
import sys
import argparse
import requests
from datetime import datetime, timedelta
from pathlib import Path

EVO_LLM_URL = os.environ.get('EVO_LLM_URL', 'http://localhost:8080')
MEMORY_SERVICE_URL = os.environ.get('EVO_MEMORY_URL', 'http://localhost:5100')
PI_LOG_DIR = os.environ.get('PI_LOG_DIR', '/tmp/conversation-logs')

CALIBRATION_PROMPT = """You are analysing James Cockburn's recent WhatsApp messages to maintain an accurate voice profile for his AI assistant Clawd.

Below is the CURRENT voice profile, followed by a sample of James's actual messages from the past week.

CURRENT PROFILE:
{CURRENT_PROFILE}

JAMES'S RECENT MESSAGES:
{MESSAGES}

Your job:
1. Compare the current profile against the actual messages.
2. Note anything the profile captures well.
3. Note anything the profile MISSES — new patterns, shifts in tone, new shorthand, new topics he cares about, changes in how he addresses Clawd.
4. Note anything in the profile that's now WRONG or outdated based on recent messages.

Then write an UPDATED profile if changes are warranted. The profile should:
- Describe how James communicates (not just surface features like "no capitals" but the personality underneath)
- Include concrete examples from recent messages where possible
- Be written in third person ("James writes..." not "You write...")
- Be 150-300 words — detailed enough to be useful, short enough to fit in context

If the current profile is still accurate and nothing meaningful has changed, respond with exactly: NO_CHANGE

Otherwise respond with the full updated profile text only. No preamble, no explanation."""


def load_james_messages(log_dir, days_back=7):
    """Load James's messages from conversation logs."""
    messages = []
    today = datetime.now()

    for i in range(days_back):
        date_str = (today - timedelta(days=i)).strftime('%Y-%m-%d')
        log_path = Path(log_dir)
        for log_file in log_path.glob(f'{date_str}_*.jsonl'):
            with open(log_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        # James's messages — not bot, sender contains James
                        if not entry.get('isBot') and 'james' in entry.get('sender', '').lower():
                            messages.append(entry.get('text', ''))
                    except json.JSONDecodeError:
                        continue

    return [m for m in messages if m and len(m) > 3]


def get_current_profile():
    """Fetch the current James voice profile from memory service."""
    try:
        resp = requests.post(
            f'{MEMORY_SERVICE_URL}/memory/search',
            json={
                'query': 'James voice style communication',
                'category': 'identity',
                'limit': 5,
            },
            timeout=10,
        )
        resp.raise_for_status()
        results = resp.json().get('results', [])
        for r in results:
            tags = r.get('memory', {}).get('tags', [])
            if 'voice' in tags and 'james' not in r.get('memory', {}).get('fact', '').lower()[:10]:
                continue
            if 'voice' in tags:
                return r['memory']
        return None
    except Exception as e:
        print(f'Failed to fetch current profile: {e}', file=sys.stderr)
        return None


def run_calibration(messages, current_profile_text):
    """Ask the local LLM to compare messages against the profile."""
    # Sample messages — don't send hundreds, pick a representative spread
    sample = messages[:80] if len(messages) > 80 else messages
    messages_text = '\n'.join(f'- {m}' for m in sample)

    prompt = CALIBRATION_PROMPT.replace('{CURRENT_PROFILE}', current_profile_text)
    prompt = prompt.replace('{MESSAGES}', messages_text)

    try:
        resp = requests.post(
            f'{EVO_LLM_URL}/v1/chat/completions',
            json={
                'messages': [
                    {'role': 'system', 'content': 'You are a communication style analyst. Be precise and concise.'},
                    {'role': 'user', 'content': prompt},
                ],
                'temperature': 0.3,
                'max_tokens': 600,
            },
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        return data['choices'][0]['message']['content'].strip()
    except Exception as e:
        print(f'LLM call failed: {e}', file=sys.stderr)
        return None


def update_profile(memory_id, new_text):
    """Update the voice profile in memory service."""
    try:
        resp = requests.put(
            f'{MEMORY_SERVICE_URL}/memory/{memory_id}',
            json={'fact': new_text},
            timeout=10,
        )
        resp.raise_for_status()
        print(f'Profile updated: {new_text[:80]}...')
        return True
    except Exception as e:
        print(f'Failed to update profile: {e}', file=sys.stderr)
        return False


def store_calibration_log(result, message_count):
    """Store a record of the calibration run."""
    try:
        requests.post(
            f'{MEMORY_SERVICE_URL}/memory/store',
            json={
                'fact': f'Style calibration ran. {message_count} messages analysed. Result: {result[:100]}',
                'category': 'system',
                'tags': ['style_calibration', datetime.now().strftime('%Y-%m-%d')],
                'confidence': 0.9,
                'source': 'style_calibration',
            },
            timeout=10,
        )
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(description='Clawd Style Calibration')
    parser.add_argument('--days', type=int, default=7, help='Days of messages to analyse')
    parser.add_argument('--log-dir', default=PI_LOG_DIR, help='Path to conversation logs')
    parser.add_argument('--dry-run', action='store_true', help='Print proposed changes without applying')
    args = parser.parse_args()

    # Step 1: Pull logs from Pi
    print('Syncing logs from Pi...')
    os.system(f'mkdir -p {args.log_dir} && scp pi@10.0.0.1:~/clawdbot/data/conversation-logs/*.jsonl {args.log_dir}/ 2>/dev/null')

    # Step 2: Load James's messages
    messages = load_james_messages(args.log_dir, args.days)
    if len(messages) < 10:
        print(f'Only {len(messages)} messages found — not enough for calibration.')
        return

    print(f'Loaded {len(messages)} messages from James over {args.days} days.')

    # Step 3: Get current profile
    profile = get_current_profile()
    if not profile:
        print('No current voice profile found in memory.')
        return

    print(f'Current profile: {profile["fact"][:60]}...')

    # Step 4: Run calibration
    result = run_calibration(messages, profile['fact'])
    if not result:
        print('Calibration failed.')
        return

    if result.strip() == 'NO_CHANGE':
        print('No style changes detected. Profile is current.')
        store_calibration_log('NO_CHANGE', len(messages))
        return

    print(f'\nProposed update:\n{result}\n')

    if args.dry_run:
        print('(dry run — not applying)')
        store_calibration_log(f'DRY_RUN: {result[:100]}', len(messages))
        return

    # Step 5: Apply update
    update_profile(profile['id'], result)
    store_calibration_log(f'UPDATED: {result[:100]}', len(messages))
    print('Style calibration complete.')


if __name__ == '__main__':
    main()
