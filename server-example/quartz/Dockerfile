FROM node:22-slim

RUN apt-get update && \
    apt-get install -y git inotify-tools rsync && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /quartz
# Pinned to last stable Quartz v4 — v5 (main) is currently broken upstream.
RUN git clone --depth 1 --branch v4.5.2 https://github.com/jackyzha0/quartz.git . && \
    npm ci

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
