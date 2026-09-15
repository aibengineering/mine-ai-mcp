# syntax=docker/dockerfile:1
FROM eclipse-temurin:21-jre AS java
FROM oven/bun:1.4.0
USER root
COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/mine-ai-mcp
COPY . .
RUN bun install --frozen-lockfile

ARG CLAUDE_CODE_VERSION=2.1.268
RUN curl -fsSL https://claude.ai/install.sh -o /tmp/install-claude.sh \
    && bash /tmp/install-claude.sh ${CLAUDE_CODE_VERSION} \
    && cp -L /root/.local/bin/claude /usr/local/bin/claude \
    && claude --version
ENV DISABLE_AUTOUPDATER=1
ARG MINECRAFT_VERSION=1.21.4
RUN bun docker/download-server.mjs ${MINECRAFT_VERSION}
ENV MINECRAFT_VERSION=${MINECRAFT_VERSION}
ENV CLAUDE_CONFIG_DIR=/private/claude
ENV HOME=/private
WORKDIR /play
EXPOSE 25565
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/bash", "/opt/mine-ai-mcp/docker/entrypoint.sh"]
