# Local validator implementation and observed evidence

Date: 5 November 2026. Scope: S5 implementation evidence; Profile B remains incomplete.

## Trusted build and supported contract

`backend/validator/Dockerfile` builds a standard-library Python JSON-call worker from `python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30`. The observed local worker image ID is `sha256:798b203a7fa41ceec7a0c693bcd52d8b3de49ee240c17f82735b8345bcbb0d41`.

`backend/validator/Scanner.Dockerfile` builds the offline scanner from `semgrep/semgrep@sha256:451b3d875c00dac7ed5db5293e584a07de11449a409c10b3c2d2652f429630b6`. The observed local scanner image ID is `sha256:08c75b6d20d75c1bf85ca0eed379eb548a0305aba7961fb1c1b0269d7578595f`. An actual scan reports Semgrep CE 1.182.1. The packaged rule-byte SHA-256 is `032f144ed074e2fc5cada5618330e575f37aeee9c77bce342b8680465538c004`.

The supported execution contract is a Python module/function taking and returning bounded JSON values, with standard-library dependencies. Trusted `ContractSuite` cases are configured in server code; candidate input never chooses expected outputs or scanner flags/rules. Expected outputs are compared in the controller after the candidate process exits. This is a bounded independent behavioral test, not proof of arbitrary-code safety. Other project/language/dependency contracts still need their own reviewed images and suites.

## Boundary and lifecycle

The actual Windows host uses Docker Desktop's Linux engine. The adapter refuses unsupported/unavailable engines, image tags, absent pinned images and an absent built-in seccomp profile. It never pulls an image during a job or executes candidate code on the host.

Each invocation uses a generated, labeled container and a newly materialized read-only source directory containing only verified snapshot files. No repository metadata, controller credentials, Docker socket or expected test outputs are mounted. The worker uses UID/GID 65532, no network, dropped capabilities, no new privileges, a read-only root, bounded no-exec temporary space, 0.5 CPU, configured memory/swap/PID/file/output/deadline limits, and no persistent Docker log driver. Effective image/user/mount/network/resource settings are inspected before start. Exit state is read from the daemon and compared with the attached process. Teardown explicitly removes the container and verifies absence even after a timeout or output flood.

The controller records validation intent, artifact revision, policy epoch, test digest, image/scanner context and every container operation ID before external effects. Live leases prevent premature reconciliation. Expired unfinished work is torn down using the recorded identities and marked interrupted. An uncertain cleanup cannot become a passing result. Passing checks do not set artifact trust or issue/reuse an action approval.

Semgrep parses all snapshot paths with fixed local custom rules, no registry resolution, metrics/version checks off, candidate ignore/suppression bypasses disabled, and JSON/SARIF reporting. Coverage/errors/findings affect the result. The rules cover the configured dynamic-execution, shell, network and synthetic prohibited-transfer patterns; they do not replace the planned CodeQL/SCA, broader rule review, provenance or human review.

The implementation follows the documented [Docker runtime constraints](https://docs.docker.com/engine/containers/run/) and [Semgrep CLI controls](https://docs.semgrep.dev/cli-reference). The version-specific ignore override is pinned and tested; changing the scanner image requires rerunning those tests.

## Reproduction

Build from the repository root, then run the integration suite from `backend`:

```powershell
docker build --network=none --tag swarmguard-validator:local backend/validator
docker build --network=none --file backend/validator/Scanner.Dockerfile --tag swarmguard-scanner:local backend/validator
Set-Location backend
$env:SWARMGUARD_TEST_VALIDATOR_IMAGE = docker image inspect swarmguard-validator:local --format '{{.Id}}'
$env:SWARMGUARD_TEST_SCANNER_IMAGE = docker image inspect swarmguard-scanner:local --format '{{.Id}}'
.venv/Scripts/python.exe -m pytest -q tests/test_response_docker.py tests/test_response_validation.py tests/test_response_git.py
```

Observed expanded focused result: **34 passed in 69.80 seconds**, including 10 real Docker/scan integration cases, 11 durable orchestration cases and 13 real Git/process cases. The full backend run passed **660 tests in 109.05 seconds**, with both immutable image environment variables enabled and no skipped Docker tests. One preexisting FastAPI/httpx deprecation warning remains. Without those variables, real Docker tests explicitly skip; those skips are not isolation evidence.

The real tests cover normal JSON behavior, no candidate plugin autoload, synthetic host-secret/environment exclusion, root/source write denial, network/socket exclusion, timeout/output cleanup, memory OOM, fresh temporary state between jobs, JSON/SARIF scan output, candidate ignore/suppression resistance and durable independent checks plus scan. Orchestration tests cover replay, changed test context, ambiguous/forged candidate results, findings, revocation during checks and expired-lease interruption.

## Remaining gates

The simulator still holds candidate code. Validator/quarantine/contract-registry API integration, authenticated human review, exact-action release, complete evidence access/retention, storage/concurrency/fairness budgets, image patch/revalidation operations, full crash/fence/clock behavior and adversarial coverage are unfinished. Containers share the Linux kernel and trust the daemon/host; gVisor and the R6 alternatives remain separate required evaluations. No production-isolation or release-profile completion is claimed.
