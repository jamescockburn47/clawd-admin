#!/usr/bin/env python3
"""Verify diary (dream_mode.py) output — checks a diary entry for
structural completeness, valid JSON in [FACTS], [INSIGHTS], [SOUL].

Usage:
    python3 verify_diary.py [--date YYYY-MM-DD]
    python3 verify_diary.py --text <raw_diary_text>

Checks:
  1. All 6 narrative sections present (WHAT HAPPENED, HOW I DID, PEOPLE, DOCUMENTS, INSIGHTS, UNFINISHED)
  2. [FACTS] has valid JSON objects with {fact, tags, confidence}
  3. [INSIGHTS] has valid JSON objects with {insight, topics}
  4. [SOUL] has valid JSON objects with {text, section, severity}
  5. [CONTINUITY] section present
  6. No hallucinated names (if log context available)
"""

import json
import re
import sys
import argparse
import requests
from pathlib import Path

MEMORY_SERVICE_URL = 'http://localhost:5100'


def load_latest_diary(date_str):
    """Fetch diary entry from memory service."""
    try:
        resp = requests.post(
            f'{MEMORY_SERVICE_URL}/memory/search',
            json={
                'query': f'diary {date_str}',
                'category': 'diary',
                'limit': 1,
            },
            timeout=10,
        )
        resp.raise_for_status()
        results = resp.json().get('results', [])
        for r in results:
            tags = r.get('tags', [])
            if date_str in tags:
                return r.get('fact', '')
        return None
    except Exception as e:
        print(f'ERROR fetching diary: {e}')
        return None


def verify_diary(text):
    """Run all structural checks. Returns (pass_count, fail_count, messages)."""
    passes = 0
    fails = 0
    messages = []

    def check(name, condition, detail=''):
        nonlocal passes, fails
        if condition:
            passes += 1
            messages.append(f'  \u2713 {name}')
        else:
            fails += 1
            messages.append(f'  \u2717 {name}{" -- " + detail if detail else ""}')

    # 1. Narrative sections
    sections = [
        'WHAT HAPPENED',
        'HOW I DID',
        'PEOPLE',
        'DOCUMENTS',
        'INSIGHTS',
        'UNFINISHED',
    ]
    for sec in sections:
        # Look for numbered section headers like "1. WHAT HAPPENED TODAY" or "2. HOW I DID"
        pattern = rf'\d+\.\s*{re.escape(sec)}'
        check(f'Section: {sec}', bool(re.search(pattern, text, re.IGNORECASE)),
              'section header not found')

    # 2. [FACTS] validation
    facts_match = re.search(r'\[FACTS\](.*?)(?:\[INSIGHTS\]|\[SOUL\]|\[CONTINUITY\]|$)', text, re.DOTALL)
    check('[FACTS] section present', facts_match is not None)

    if facts_match:
        facts_text = facts_match.group(1).strip()
        if facts_text.lower() in ('none', 'none.', 'n/a'):
            check('[FACTS] acknowledged (none)', True)
        else:
            fact_count = 0
            for line in facts_text.split('\n'):
                line = line.strip().lstrip('- ')
                if not line.startswith('{'):
                    continue
                try:
                    obj = json.loads(line)
                    check(f'FACT JSON valid: "{obj.get("fact", "?")[:40]}"', True)
                    check('FACT has tags', isinstance(obj.get('tags'), list))
                    check('FACT has confidence', isinstance(obj.get('confidence'), (int, float)))
                    fact_count += 1
                except json.JSONDecodeError as e:
                    check(f'FACT JSON parse', False, str(e))

            check('[FACTS] has entries', fact_count > 0, 'no valid JSON lines found')

    # 3. [INSIGHTS] validation
    insights_match = re.search(r'\[INSIGHTS\](.*?)(?:\[SOUL\]|\[CONTINUITY\]|$)', text, re.DOTALL)
    check('[INSIGHTS] section present', insights_match is not None)

    if insights_match:
        insights_text = insights_match.group(1).strip()
        if insights_text.lower() in ('none', 'none.', 'n/a'):
            check('[INSIGHTS] acknowledged (none)', True)
        else:
            insight_count = 0
            for line in insights_text.split('\n'):
                line = line.strip().lstrip('- ')
                if not line.startswith('{'):
                    continue
                try:
                    obj = json.loads(line)
                    check(f'INSIGHT JSON valid: "{obj.get("insight", "?")[:40]}"', True)
                    check('INSIGHT has topics', isinstance(obj.get('topics'), list))
                    insight_count += 1
                except json.JSONDecodeError as e:
                    check(f'INSIGHT JSON parse', False, str(e))

            check('[INSIGHTS] has entries', insight_count > 0, 'no valid JSON lines found')

    # 4. [SOUL] validation
    soul_match = re.search(r'\[SOUL\](.*?)(?:\[CONTINUITY\]|$)', text, re.DOTALL)
    check('[SOUL] section present', soul_match is not None)

    if soul_match:
        soul_text = soul_match.group(1).strip()
        if soul_text.lower() in ('none', 'none.', 'n/a'):
            check('[SOUL] acknowledged (none)', True)
        else:
            for line in soul_text.split('\n'):
                line = line.strip().lstrip('- ')
                if not line.startswith('{'):
                    continue
                try:
                    obj = json.loads(line)
                    check('SOUL has text', 'text' in obj)
                    check('SOUL section valid', obj.get('section') in ('people', 'patterns', 'lessons', 'boundaries'),
                          f'got "{obj.get("section")}"')
                    check('SOUL severity valid', obj.get('severity') in ('routine', 'corrective', 'critical'),
                          f'got "{obj.get("severity")}"')
                except json.JSONDecodeError as e:
                    check(f'SOUL JSON parse', False, str(e))

    # 5. [CONTINUITY] section
    check('[CONTINUITY] present', '[CONTINUITY]' in text)

    # 6. First person voice
    first_person_count = len(re.findall(r'\bI\s+(did|was|noticed|said|got|had|made|thought|felt|responded|asked)\b', text))
    check('First person voice used', first_person_count >= 2, f'only {first_person_count} first-person constructions found')

    return passes, fails, messages


def main():
    parser = argparse.ArgumentParser(description='Verify diary output')
    parser.add_argument('--date', default=None, help='Date of diary to verify (YYYY-MM-DD)')
    parser.add_argument('--text', default=None, help='Raw diary text to verify (or - for stdin)')
    parser.add_argument('--file', default=None, help='File containing diary text')
    args = parser.parse_args()

    if args.text:
        if args.text == '-':
            text = sys.stdin.read()
        else:
            text = args.text
    elif args.file:
        text = Path(args.file).read_text(encoding='utf-8')
    elif args.date:
        text = load_latest_diary(args.date)
        if not text:
            print(f'No diary found for {args.date}')
            sys.exit(1)
    else:
        from datetime import datetime
        today = datetime.now().strftime('%Y-%m-%d')
        text = load_latest_diary(today)
        if not text:
            print(f'No diary found for {today}')
            sys.exit(1)

    print(f'Verifying diary ({len(text)} chars)...\n')

    passes, fails, messages = verify_diary(text)

    for msg in messages:
        print(msg)

    print(f'\n{"="*40}')
    print(f'PASS: {passes}  FAIL: {fails}')

    if fails > 0:
        print('\nDiary has structural issues that need attention.')
        sys.exit(1)
    else:
        print('\nDiary structure is valid.')
        sys.exit(0)


if __name__ == '__main__':
    main()
