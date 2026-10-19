"""Self-test for check_writing.py: python3 test_check_writing.py"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(__file__))
from check_writing import check

GOOD = """# Plan

Status: approved · Revision: 2

The registry stores each request exactly as written.

- The page shows the work as a tree.
- FR-1: The system keeps each request as written.
- Steps run in order:
  - Build waits for approvals.

| ID | Title | Status | PR |
|---|---|---|---|
| T-1 | Add a page that shows the tracker as a tree. | done | #34 |

```
code — with a dash, ignored
```
"""
BAD = """The registry — stores requests.

- tracker page
- Registry: request storage

| ID | Title |
|---|---|
| T-1 | Tracker page and tree reviews |
"""

def run(text):
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(text)
    return check(f.name)

good = run(GOOD)
assert good == [], good
bad = [p for _, p, _ in run(BAD)]
assert any("dash" in p for p in bad), bad
assert sum("period" in p for p in bad) >= 3, bad
assert any("lowercase" in p for p in bad), bad
print("ok")
