"""Compare installed Expo/RN packages against the versions Expo SDK expects.

A mismatch here is not cosmetic: native modules are compiled against
expo-modules-core's Kotlin API. If a module is built for an older core, its
generated `definition()` code can reference classes that no longer exist, and
the app dies at startup with NoClassDefFoundError before any JS runs.
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


pkg = read_json(os.path.join(ROOT, "package.json")) or {}
bundled = read_json(os.path.join(ROOT, "node_modules", "expo", "bundledNativeModules.json")) or {}

deps = {}
deps.update(pkg.get("dependencies", {}))
deps.update(pkg.get("devDependencies", {}))

print(f"declared deps: {len(deps)}   SDK-expected entries: {len(bundled)}")
print()

mismatches = []
for name, declared in sorted(deps.items()):
    expected = bundled.get(name)
    if not expected:
        continue

    installed_json = read_json(os.path.join(ROOT, "node_modules", name, "package.json"))
    installed = installed_json.get("version") if installed_json else "<not installed>"

    # Compare the installed version's major against the expected range's major.
    # Expo pins these by major (e.g. ~57.0.5), so a differing major is the
    # dangerous case; a differing minor/patch is usually benign.
    exp_major = re.search(r"(\d+)", expected)
    inst_major = re.match(r"(\d+)", str(installed))
    bad = bool(exp_major and inst_major and exp_major.group(1) != inst_major.group(1))

    if bad:
        mismatches.append((name, declared, expected, installed))
    else:
        flag = "ok"
        print(f"  [{flag}] {name:<28} installed={installed:<12} expected={expected}")

print()
if mismatches:
    print("=" * 72)
    print("MAJOR VERSION MISMATCHES  (these can crash native init)")
    print("=" * 72)
    for name, declared, expected, installed in mismatches:
        print(f"  {name}")
        print(f"      package.json declares : {declared}")
        print(f"      actually installed    : {installed}")
        print(f"      SDK 57 expects        : {expected}")
        print(f"      fix -> npm i {name}@{expected.lstrip('~^')}")
else:
    print("No major mismatches found.")

print()
print("=" * 72)
print("SDK-expected packages NOT in package.json")
print("=" * 72)
for name in sorted(bundled):
    if name not in deps and os.path.isdir(os.path.join(ROOT, "node_modules", name)):
        print(f"  present in node_modules but undeclared: {name}")
