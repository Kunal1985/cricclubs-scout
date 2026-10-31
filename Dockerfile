FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates wget \
  && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
  && apt-get install -y /tmp/chrome.deb \
  && rm -rf /var/lib/apt/lists/* /tmp/chrome.deb

ENV CHROME_PATH=/usr/bin/google-chrome-stable
ENV PORT=10000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 10000
CMD ["node", "server/index.js"]
