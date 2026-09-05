ARG BASE_IMAGE=ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
FROM ${BASE_IMAGE}

ARG TARGETARCH
ARG NODE_VERSION=24.8.0
ARG NODE_LINUX_X64_SHA256=2598641d188b41793930917f1a99a81c9615856b4205d408a44ab676c1acbb3d
ARG CHROME_VERSION=152.0.7977.75
ARG CHROME_LINUX_X64_SHA256=a16d36890636bd72251133b27f05825f7f9269c2425b3408fa3a76e10dccd8f1

ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/evaluator/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
    AGENT_BROWSER_EXECUTABLE_PATH=/opt/chrome/chrome

RUN test "${TARGETARCH}" = "amd64" \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      fonts-freefont-ttf \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      jq \
      libatomic1 \
      libasound2t64 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo-gobject2 \
      libcairo2 \
      libxcomposite1 \
      libcups2 \
      libxcursor1 \
      libxdamage1 \
      libdbus-1-3 \
      libdrm2 \
      libxfixes3 \
      libfontconfig1 \
      libfreetype6 \
      libgbm1 \
      libgdk-pixbuf-2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libnss3-tools \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libxrandr2 \
      libxrender1 \
      libxcb-shm0 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxext6 \
      libxkbcommon0 \
      libxshmfence1 \
      libxi6 \
      python3 \
      python3-pip \
      python3-venv \
      tini \
      xdg-utils \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --silent --show-error --location \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      --output /tmp/node.tar.xz \
    && printf '%s  %s\n' "${NODE_LINUX_X64_SHA256}" /tmp/node.tar.xz | sha256sum --check --status \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm -f /tmp/node.tar.xz \
    && node --version \
    && npm --version

WORKDIR /opt/evaluator
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && droid --version \
    && agent-browser --version

# Pin Chrome independently of agent-browser's moving download selection.
# Runtime containers are read-only and non-root, so it is staged in the image.
RUN curl --fail --silent --show-error --location \
      "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" \
      --output /tmp/chrome.zip \
    && printf '%s  %s\n' "${CHROME_LINUX_X64_SHA256}" /tmp/chrome.zip | sha256sum --check --status \
    && python3 -m zipfile -e /tmp/chrome.zip /opt/chrome-extract \
    && mv /opt/chrome-extract/chrome-linux64 /opt/chrome \
    && chmod 0755 /opt/chrome/chrome /opt/chrome/chrome_crashpad_handler /opt/chrome/chrome_sandbox \
    && /opt/chrome/chrome --version | grep -F "${CHROME_VERSION}" \
    && rm -rf /tmp/chrome.zip /opt/chrome-extract

# The authenticated egress sidecars and isolated inner worker share this image.
# The key is mounted only into the sidecars, never either model container.
COPY requirements.lock /opt/evaluator/requirements.lock
RUN python3 -m venv /opt/mitmproxy \
    && /opt/mitmproxy/bin/pip install --no-cache-dir --requirement /opt/evaluator/requirements.lock \
    && /opt/mitmproxy/bin/mitmdump --version

COPY auth-proxy.py /opt/evaluator/auth-proxy.py
COPY container-entrypoint.sh /opt/evaluator/container-entrypoint.sh
COPY evaluator-handoff.sh /usr/local/bin/wisp-evaluator-handoff
COPY droid-wrapper.sh /opt/evaluator/droid-wrapper.sh
COPY run-model.sh /opt/evaluator/run-model.sh
COPY run-preflight.py /opt/evaluator/run-preflight.py
COPY collect-evidence.py /opt/evaluator/collect-evidence.py
COPY redact-evidence.py /opt/evaluator/redact-evidence.py
COPY fake-droid.py /opt/evaluator/fake-droid.py
COPY inner-client.py /opt/evaluator/inner-client.py
COPY inner-client.py /opt/inner/inner-client.py
COPY inner-worker.py /opt/inner/inner-worker.py
COPY prompt.md /opt/evaluator/prompt.md
COPY fixture/ /opt/evaluator/fixture/
COPY hidden-oracle.py /opt/evaluator/hidden-oracle.py

RUN chmod -R a+rX /opt/evaluator \
    && chmod 0755 \
      /opt/evaluator/container-entrypoint.sh \
      /usr/local/bin/wisp-evaluator-handoff \
      /opt/evaluator/droid-wrapper.sh \
      /opt/evaluator/run-model.sh \
      /opt/evaluator/run-preflight.py \
      /opt/evaluator/collect-evidence.py \
      /opt/evaluator/redact-evidence.py \
      /opt/evaluator/fake-droid.py \
      /opt/evaluator/inner-client.py \
      /opt/inner/inner-client.py \
      /opt/inner/inner-worker.py \
      /opt/evaluator/hidden-oracle.py \
    && printf '%s\n' 'evaluator:x:10001:' >> /etc/group \
    && printf '%s\n' 'evaluator:x:10001:10001:Wisp evaluator:/home/evaluator:/bin/bash' >> /etc/passwd \
    && mkdir -p \
      /workspace \
      /worktrees \
      /repo-git \
      /run/inner-rpc \
      /evidence \
      /release \
      /home/evaluator \
      /home/inner \
      /opt/evaluator-tools/node_modules \
      /opt/inner/node_modules \
    && cp /opt/evaluator/droid-wrapper.sh /opt/evaluator-tools/droid-wrapper.sh \
    && cp /opt/evaluator/fake-droid.py /opt/evaluator-tools/fake-droid.py \
    && cp /opt/evaluator/inner-client.py /opt/evaluator-tools/inner-client.py \
    && cp -al /opt/evaluator/node_modules/. /opt/inner/node_modules/ \
    && cp /opt/evaluator/fake-droid.py /opt/inner/fake-droid.py \
    && chown -R 10001:10001 \
      /workspace \
      /worktrees \
      /repo-git \
      /run/inner-rpc \
      /evidence \
      /home/evaluator \
      /home/inner \
    && chmod 0700 /home/inner

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/evaluator/container-entrypoint.sh"]
