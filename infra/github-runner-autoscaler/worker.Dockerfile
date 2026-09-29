FROM n150/github-pi-runner:0.87.1

USER root
COPY infra/github-runner-autoscaler/worker-entrypoint.sh /usr/local/bin/pi-runner-entrypoint
RUN chmod +x /usr/local/bin/pi-runner-entrypoint \
    && npm install -g @gitlab/orbit@0.130.0 \
    && orbit version

USER runner
ENTRYPOINT ["/usr/local/bin/pi-runner-entrypoint"]
