"""Fixed offline Semgrep CE job, separate from candidate execution containers."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    # Consume the executor's bounded envelope, but never accept flags/rules from it.
    sys.stdin.buffer.read(65537)
    root = Path('/candidate')
    files = sorted(str(path) for path in root.rglob('*') if path.is_file())
    rules = Path('/opt/swarmguard/rules.yaml')
    # Explicit targets and ignore suppression prevent candidate .semgrepignore,
    # .gitignore and nosem annotations from hiding source. Pinning + integration
    # tests cover the version-specific ignore override flag.
    command = ['semgrep', 'scan', '--config', str(rules), '--json',
               '--sarif-output', '/tmp/report.sarif', '--metrics=off', '--disable-version-check',
               '--disable-nosem', '--no-git-ignore', '--x-ignore-semgrepignore-files',
               '--no-rewrite-rule-ids', '--strict', '--jobs', '1', '--timeout', '5',
               '--max-target-bytes', '262144', *files]
    env = dict(os.environ, SEMGREP_SEND_METRICS='off', SEMGREP_ENABLE_VERSION_CHECK='0')
    result = subprocess.run(command, capture_output=True, env=env, timeout=45, check=False)
    if len(result.stdout) > 100000:
        raise RuntimeError('scanner JSON exceeds report budget')
    sarif = Path('/tmp/report.sarif').read_bytes()
    if len(sarif) > 100000:
        raise RuntimeError('scanner SARIF exceeds report budget')
    report = json.loads(result.stdout)
    print(json.dumps({'report': report, 'sarif': json.loads(sarif), 'scanner_exit': result.returncode,
        'rules_digest': hashlib.sha256(rules.read_bytes()).hexdigest(),
        'stderr_preview': result.stderr.decode(errors='replace')[:1024]}, allow_nan=False))


if __name__ == '__main__':
    main()
