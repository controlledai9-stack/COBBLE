# Rebuild deliberately when updating the reviewed Python base or worker.
FROM python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30
COPY worker.py /opt/swarmguard/worker.py
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/python", "-I", "-B", "/opt/swarmguard/worker.py"]
