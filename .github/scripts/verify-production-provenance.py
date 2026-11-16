#!/usr/bin/env python3
"""Fail-closed: require successful main-push verification of the exact release commit."""
import io
import json
import os
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import zipfile

repo = os.environ['GH_REPO']
token = os.environ['GH_TOKEN']
approved = os.environ['APPROVED_SHA'].lower()


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def request(path, binary=False):
    """Fetch GitHub API JSON or an artifact ZIP without leaking the API token.

    Artifact downloads return a temporary HTTPS redirect. Do not forward
    Authorization to the redirect destination.
    """
    api_url = 'https://api.github.com' + path
    headers = {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }
    if not binary:
        with urllib.request.urlopen(
            urllib.request.Request(api_url, headers=headers), timeout=25
        ) as response:
            return json.load(response)

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(urllib.request.Request(api_url, headers=headers), timeout=25):
            raise RuntimeError('Expected GitHub artifact download redirect.')
    except urllib.error.HTTPError as exc:
        if exc.code not in (302, 303, 307, 308):
            raise
        location = exc.headers.get('Location')
        if not location:
            raise RuntimeError('Artifact redirect has no Location header.')

    parsed = urllib.parse.urlparse(location)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError('Invalid artifact download redirect.')

    # A fresh request carries no GitHub API authorization header.
    with urllib.request.urlopen(urllib.request.Request(location), timeout=25) as response:
        return response.read()


if len(approved) != 40 or any(c not in '0123456789abcdef' for c in approved):
    raise SystemExit('STOP: Invalid approved SHA.')
if git('rev-parse', 'HEAD') != approved:
    raise SystemExit('STOP: Checkout is not the approved commit.')
current_main = request(f'/repos/{repo}/branches/main')['commit']['sha']
if approved != current_main:
    raise SystemExit('STOP: Approved commit is not current remote main HEAD.')
tree = git('rev-parse', approved + '^{tree}')

# A successful push run on main verifies the final Git commit, regardless of
# merge/squash/rebase strategy. The artifact is written only after pnpm verify.
verified = False
for page in range(1, 11):
    query = urllib.parse.urlencode({
        'event': 'push', 'branch': 'main', 'status': 'success',
        'per_page': 100, 'page': page,
    })
    runs = request(f'/repos/{repo}/actions/workflows/verify.yml/runs?{query}').get('workflow_runs', [])
    for run in runs:
        if (run.get('conclusion') != 'success' or run.get('event') != 'push'
                or run.get('head_branch') != 'main' or run.get('head_sha') != approved):
            continue
        run_id = run['id']
        artifacts = request(f'/repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100').get('artifacts', [])
        name = f'healthcloud-main-provenance-{run_id}'
        candidates = [a for a in artifacts if a.get('name') == name and not a.get('expired')]
        if len(candidates) != 1:
            continue
        archive = request(f'/repos/{repo}/actions/artifacts/{candidates[0]["id"]}/zip', binary=True)
        with zipfile.ZipFile(io.BytesIO(archive)) as z:
            evidence = json.loads(z.read('provenance.json'))
        if evidence == {
            'repository': repo,
            'event': 'push',
            'branch': 'main',
            'run_id': run_id,
            'verified_commit_sha': approved,
            'verified_tree_sha': tree,
        }:
            verified = True
            print(f'PASS: Exact main commit and tree verified by successful run {run_id}.')
            break
    if verified or len(runs) < 100:
        break
if not verified:
    raise SystemExit('STOP: No successful main CI artifact verifies this exact commit/tree. No PROD changes.')
