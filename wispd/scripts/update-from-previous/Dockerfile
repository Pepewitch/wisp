# The update-from-previous gate's container: the same pinned Ubuntu base as
# the installer and activation contracts, plus Supervisor (a documented,
# container-friendly restart supervisor; its dependency python3 also runs the
# release mirror), Git for the sample project, and curl for health probes.
# ca-certificates brings the openssl CLI that mints the throwaway test CA.
ARG BASE_IMAGE=ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517
FROM ${BASE_IMAGE}

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      supervisor \
    && rm -rf /var/lib/apt/lists/*
