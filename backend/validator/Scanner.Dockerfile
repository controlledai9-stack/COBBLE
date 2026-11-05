FROM semgrep/semgrep@sha256:451b3d875c00dac7ed5db5293e584a07de11449a409c10b3c2d2652f429630b6
COPY scanner_worker.py rules.yaml /opt/swarmguard/
ENV SEMGREP_SEND_METRICS=off SEMGREP_ENABLE_VERSION_CHECK=0
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["python3", "-I", "-B", "/opt/swarmguard/scanner_worker.py"]
