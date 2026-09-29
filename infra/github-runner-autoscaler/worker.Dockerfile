FROM n150/github-pi-runner:0.87.1

USER root
COPY infra/github-runner-autoscaler/worker-entrypoint.sh /usr/local/bin/pi-runner-entrypoint
RUN chmod +x /usr/local/bin/pi-runner-entrypoint \
    && npm install -g @gitlab/orbit@0.130.0 \
    && orbit version \
    && git init /opt/pi-repomap \
    && git -C /opt/pi-repomap remote add origin https://github.com/EnTeQuAk/pi-repomap.git \
    && git -C /opt/pi-repomap fetch --depth 1 origin a4a2c85685a7a06ec850b23a2ae1bb7c9ecde9ab \
    && git -C /opt/pi-repomap checkout --detach FETCH_HEAD \
    && npm --prefix /opt/pi-repomap install --omit=dev --legacy-peer-deps

USER runner
ENTRYPOINT ["/usr/local/bin/pi-runner-entrypoint"]
