#!/usr/bin/env python3
import glob
import json
import os
import sys

UA_GOOGLEBOT = "Googlebot/2.1 (+http://www.google.com/bot.html)"


def parse_args(argv):
    root = "."
    all_flag = False
    output = None
    for a in argv:
        if a == "--all":
            all_flag = True
        elif a.startswith("--output="):
            output = a.split("=", 1)[1]
        elif not a.startswith("-"):
            root = a
    return root, all_flag, output


def main():
    root, all_flag, output = parse_args(sys.argv[1:])
    rules_dir = os.path.join(root, "config", "rules")
    manifest = {
        "version": 1,
        "failover": {"timeout_ms": 6000, "max_fails": 2, "cooldown_s": 45},
        "routes": [],
    }
    if not os.path.isdir(rules_dir):
        sys.stderr.write("rules dir not found: %s\n" % rules_dir)
        sys.exit(1)
    for fp in sorted(glob.glob(os.path.join(rules_dir, "*.json"))):
        with open(fp, encoding="utf-8") as f:
            data = json.load(f)
        if not data.get("enabled", False) and not all_flag:
            continue
        hosts = []
        for site in data.get("sites", []):
            for h in site.get("hosts", []):
                if h not in hosts:
                    hosts.append(h)
        if not hosts:
            continue
        group = data.get("group") or "misc"
        route = {
            "id": data.get("id") or os.path.splitext(os.path.basename(fp))[0],
            "group": group,
            "name": data.get("name", ""),
            "mode": "same-host",
            "hosts": hosts,
            "ua": UA_GOOGLEBOT if group == "steam" else None,
            "upstreams": [],
        }
        manifest["routes"].append(route)

    text = json.dumps(manifest, ensure_ascii=False, indent=2)
    if output:
        with open(output, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        sys.stderr.write("wrote %d routes -> %s\n" % (len(manifest["routes"]), output))
    else:
        print(text)


if __name__ == "__main__":
    main()