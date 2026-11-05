"""Typed offline scanner outcomes. A clean scan is evidence, never approval."""
from __future__ import annotations

from app.modules.response.adapters.docker import DockerBudget, DockerJsonExecutor
from app.modules.response.repository import Unavailable, digest


class SemgrepScanner(DockerJsonExecutor):
    def __init__(self, artifacts, staging_root, image, *, workspace, rules_digest: str):
        super().__init__(artifacts, staging_root, image, workspace=workspace,
                         budget=DockerBudget(seconds=60, output_bytes=262144, memory_mb=512, pids=64))
        if len(rules_digest) != 64 or any(c not in '0123456789abcdef' for c in rules_digest):
            raise ValueError('reviewed rule digest required')
        self.rules_digest = rules_digest

    def context(self):
        return {'engine': 'semgrep-ce', 'image': self.image, 'rules_digest': self.rules_digest}

    def scan(self, artifact_id, *, operation_id):
        from app.modules.response.validation import strict_json
        result = self.invoke(artifact_id, 'scanner', 'scan', [], {}, operation_id=operation_id)
        if result['exit_code'] or result['oom_killed']:
            raise Unavailable('isolated scanner did not complete successfully')
        try:
            envelope = strict_json(result['stdout'])
            report, sarif = envelope['report'], envelope['sarif']
            if (envelope['rules_digest'] != self.rules_digest or envelope['scanner_exit'] != 0
                    or not isinstance(report['results'], list) or not isinstance(report['errors'], list)
                    or sarif['version'] != '2.1.0' or not isinstance(sarif['runs'], list)):
                raise ValueError('scanner context or report schema differs')
            files = self.artifacts.read(artifact_id)
            scanned = {name.removeprefix('/candidate/') for name in report.get('paths', {}).get('scanned', [])}
            # Hold unsupported/unparsed files rather than claiming full scan coverage.
            coverage = set(files) <= scanned
            findings = []
            for finding in report['results']:
                name = finding['path'].removeprefix('/candidate/')
                if name not in files:
                    raise ValueError('scanner location outside candidate identity')
                findings.append({'rule_id': str(finding['check_id'])[:200], 'path': name,
                    'line': int(finding['start']['line']), 'column': int(finding['start']['col']),
                    'severity': str(finding['extra']['severity'])[:16],
                    'message': str(finding['extra']['message'])[:1024]})
            return {**self.context(), 'version': str(report['version'])[:64], 'image_id': result['image_id'],
                'artifact_id': artifact_id, 'passed': not findings and not report['errors'] and coverage,
                'coverage_complete': coverage, 'scanned_paths': sorted(scanned), 'findings': findings,
                'errors': report['errors'], 'sarif': sarif, 'report_digest': digest(report),
                'sarif_digest': digest(sarif), 'assurance': 'bounded custom CE rules; not proof of absence of vulnerabilities'}
        except (ValueError, TypeError, KeyError, RecursionError) as exc:
            raise Unavailable('invalid or inapplicable scanner evidence') from exc
