FROM python:3.12-slim-bookworm AS builder
WORKDIR /app
# Apply available OS security patches and remove unused Perl (not needed by Python app)
RUN apt-get update && apt-get upgrade -y \
 && apt-get purge -y --allow-remove-essential perl-base \
 && dpkg --purge --force-depends libsqlite3-0 libncursesw6 libtinfo6 \
 && (dpkg --purge --force-all ncurses-base ncurses-bin 2>/dev/null || true) \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --upgrade pip setuptools wheel
RUN pip install --no-cache-dir -r requirements.txt
# Explicit post-install pin to guarantee secure versions land in site-packages
RUN pip install --upgrade "pip>=25.3" "wheel>=0.46.2" "jaraco.context>=6.1.0"

FROM python:3.12-slim-bookworm
WORKDIR /app

# Apply available OS security patches and remove unused Perl (not needed by Python app)
RUN apt-get update && apt-get upgrade -y \
 && apt-get purge -y --allow-remove-essential perl-base \
 && dpkg --purge --force-depends libsqlite3-0 libncursesw6 libtinfo6 \
 && (dpkg --purge --force-all ncurses-base ncurses-bin 2>/dev/null || true) \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 appuser \
 && useradd --uid 10001 --gid appuser --no-create-home appuser

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin/uvicorn /usr/local/bin/uvicorn

# Upgrade pip toolchain in the runtime layer so Trivy sees secure versions
RUN pip install --upgrade "pip>=25.3" "wheel>=0.46.2" "jaraco.context>=6.1.0"

COPY . .

USER appuser
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
