#!/usr/bin/env python3
"""Read-only publication preflight. Network/API errors always block publication."""
import argparse
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request


def get_json(path):
    request = urllib.request.Request(
        "https://api.github.com/" + path,
        headers={"Accept": "application/vnd.github+json",
                 "Authorization": "Bearer " + os.environ["GH_TOKEN"],
                 "User-Agent": "AdBlock-Pro-Release-Guard",
                 "X-GitHub-Api-Version": "2022-11-28"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def check_release(repo, tag, sha, fetch=get_json):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("invalid repository")
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", tag) or "-dev." in tag:
        raise ValueError("invalid release version")
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("invalid release SHA")
    branch = fetch(f"repos/{repo}/git/ref/heads/main")
    if not branch or branch["object"]["sha"] != sha:
        raise ValueError("release SHA is not current main")
    encoded = urllib.parse.quote(tag, safe="")
    if fetch(f"repos/{repo}/releases/tags/{encoded}") is not None:
        raise ValueError("Release already exists; bump module.prop")
    if fetch(f"repos/{repo}/git/ref/tags/{encoded}") is not None:
        raise ValueError("Tag already exists; never reuse an existing tag")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--sha", required=True)
    args = parser.parse_args()
    check_release(args.repo, args.tag, args.sha)
    print("Publication preflight passed; no existing Release or tag.")


if __name__ == "__main__":
    main()
