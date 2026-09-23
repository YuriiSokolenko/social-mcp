FROM docker:28-cli

RUN apk add --no-cache bash curl jq coreutils

COPY infra/github-runner-autoscaler/manager.sh /usr/local/bin/pi-runner-manager
RUN chmod +x /usr/local/bin/pi-runner-manager

ENTRYPOINT ["/usr/local/bin/pi-runner-manager"]
