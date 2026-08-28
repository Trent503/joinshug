#!/usr/bin/env python3
"""
Set the Agents demo phone number everywhere it appears.

    python3 tools/set-demo-number.py "+1 555 555 0123"

Rewrites both the tel: href and the visible number. Safe to re-run: it matches
whatever number is currently in place, so you can change it as often as you like.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLACEHOLDER = "+15550000000"


def fmt(digits):
    """(555) 555-0123 for a US 10-digit number, else return it unchanged."""
    d = re.sub(r"\D", "", digits)
    if len(d) == 11 and d.startswith("1"):
        d = d[1:]
    if len(d) != 10:
        return None
    return f"({d[:3]}) {d[3:6]}-{d[6:]}"


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    raw = argv[1]
    digits = re.sub(r"\D", "", raw)
    if len(digits) < 10:
        print(f"not enough digits in {raw!r} -- need at least 10")
        return 1
    tel = "+" + (digits if digits.startswith("1") else "1" + digits)
    pretty = fmt(digits) or raw

    changed = []
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in (".git", "tools", "assets")]
        for f in fn:
            if not f.endswith(".html"):
                continue
            path = os.path.join(dp, f)
            s = open(path).read()
            before = s
            # tel: href, whatever it currently is
            s = re.sub(r'href="tel:\+?\d+"', f'href="tel:{tel}"', s)
            # visible number inside the demo button
            s = re.sub(r"(Call the demo — )\(?\d{3}\)?[ -]?\d{3}-?\d{4}",
                       lambda m: m.group(1) + pretty, s)
            if s != before:
                open(path, "w").write(s)
                changed.append(os.path.relpath(path, ROOT))

    if not changed:
        print("no demo number found in any page -- nothing changed")
        return 1
    print(f"demo number set to {pretty}  (tel:{tel})")
    for c in changed:
        print(f"  {c}")
    print("\nnow run:  python3 tools/check.py")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
