FROM n150/github-pi-runner:0.87.1

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 983 hostdocker \
    && usermod -aG hostdocker runner
# GID 983 must match the `docker` group owning /var/run/docker.sock on the N150
# host (verify with `stat -c %g /var/run/docker.sock` on beelink before reusing
# this Dockerfile on a different host) -- the socket is bind-mounted into this
# container so its CI jobs can run `docker compose`, sibling-container style.

COPY infra/github-runner-autoscaler/worker-entrypoint.sh /usr/local/bin/pi-runner-entrypoint
RUN chmod +x /usr/local/bin/pi-runner-entrypoint

USER runner
ENTRYPOINT ["/usr/local/bin/pi-runner-entrypoint"]
