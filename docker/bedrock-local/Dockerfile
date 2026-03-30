FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive
ARG BEDROCK_SOURCE_DIR=bedrock-server-1.26.10.4-linux

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tzdata libcurl4 libssl3 libstdc++6 python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/bedrock-template

COPY ${BEDROCK_SOURCE_DIR}/ ./
COPY addon /opt/addons
COPY docker/bedrock-local/entrypoint.sh /usr/local/bin/bedrock-entrypoint.sh
COPY docker/bedrock-local/patch_level_dat.py /usr/local/bin/patch-level-dat.py

RUN chmod +x /usr/local/bin/bedrock-entrypoint.sh \
  && chmod +x /opt/bedrock-template/bedrock_server

EXPOSE 19132/udp 19133/udp

VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/bedrock-entrypoint.sh"]
