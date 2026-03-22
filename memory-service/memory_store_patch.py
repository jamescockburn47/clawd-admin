"""Patch script — adds identity protection to memory_store.py on EVO."""
import re

with open("/home/james/clawdbot-memory/memory_store.py", "r") as f:
    code = f.read()

# 1. Add PROTECTED_CATEGORIES constant after imports
code = code.replace(
    'import config\n',
    'import config\n\n# Categories that are never expired, deduplicated, or superseded\nPROTECTED_CATEGORIES = {"identity"}\n'
)

# 2. Protect deduplicate — skip protected categories
code = code.replace(
    '            if i in to_remove:\n                continue\n            for j in range(i + 1, n):',
    '            if i in to_remove:\n                continue\n            if self.memories[i].get("category") in PROTECTED_CATEGORIES:\n                continue\n            for j in range(i + 1, n):'
)
code = code.replace(
    '                if j in to_remove:\n                    continue\n                sim = float',
    '                if j in to_remove:\n                    continue\n                if self.memories[j].get("category") in PROTECTED_CATEGORIES:\n                    continue\n                sim = float'
)

# 3. Protect expire_old — skip protected categories
code = code.replace(
    '            if m.get("expires"):\n                try:\n                    exp = datetime.strptime(m["expires"], "%Y-%m-%d")\n                    if exp < now:\n                        expired.append(m)\n                except ValueError:\n                    pass',
    '            if m.get("category") in PROTECTED_CATEGORIES:\n                continue\n            if m.get("expires"):\n                try:\n                    exp = datetime.strptime(m["expires"], "%Y-%m-%d")\n                    if exp < now:\n                        expired.append(m)\n                except ValueError:\n                    pass'
)

# 4. Protect store — prevent superseding identity memories
code = code.replace(
    '        if supersedes:\n            for m in self.memories:\n                if m["id"] == supersedes:',
    '        if supersedes:\n            for m in self.memories:\n                if m["id"] == supersedes:\n                    if m.get("category") in PROTECTED_CATEGORIES:\n                        break  # Cannot supersede identity memories'
)

with open("/home/james/clawdbot-memory/memory_store.py", "w") as f:
    f.write(code)

print("Patched memory_store.py with identity protection")
