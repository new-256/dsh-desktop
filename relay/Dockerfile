# dsh-mobile-relay 容器镜像（零依赖，Node 20 alpine 最小面）
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY lib/ ./lib/
COPY bin/ ./bin/
COPY README.md ./
EXPOSE 8443
# 密钥经环境变量注入（--key 不写进镜像层）
CMD ["node", "bin/dsh-mobile-relay.mjs", "--port", "8443", "--host", "0.0.0.0", "--key", "${RELAY_KEY}"]
