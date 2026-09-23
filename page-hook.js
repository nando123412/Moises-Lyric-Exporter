(() => {
  const SOURCE = "moises-lyrics-exporter-page-hook";

  const isMoisesApiUrl = (url) => typeof url === "string" && /https:\/\/api\.moises\.ai\//i.test(url);
  const safePreview = (value, max = 500) => {
    if (value == null) return null;
    try {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return text.length > max ? text.slice(0, max) : text;
    } catch (_) {
      return "[unserializable]";
    }
  };

  const postNetworkEvent = (payload) => {
    window.postMessage({ source: SOURCE, type: "MOISES_NETWORK", ...payload }, "*");
  };

  const parseBody = (body) => {
    if (body == null) return null;
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      const items = [];
      for (const [key, value] of body.entries()) {
        items.push([key, typeof value === "string" ? value : value?.name || "[binary]"]);
      }
      return JSON.stringify(items);
    }
    if (body instanceof Blob) return `[Blob ${body.type || "unknown"} ${body.size || 0}]`;
    if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength}]`;
    if (ArrayBuffer.isView(body)) return `[TypedArray ${body.byteLength}]`;
    try {
      return JSON.stringify(body);
    } catch (_) {
      return String(body);
    }
  };

  const hookFetch = () => {
    if (typeof window.fetch !== "function") return;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (...args) => {
      const requestInput = args[0];
      const requestInit = args[1] || {};
      const requestUrl = typeof requestInput === "string" ? requestInput : requestInput?.url || "";
      const method = String(requestInit.method || requestInput?.method || "GET").toUpperCase();

      let requestBody = requestInit.body || null;
      if (!requestBody && requestInput && typeof Request !== "undefined" && requestInput instanceof Request) {
        try {
          requestBody = await requestInput.clone().text();
        } catch (_) {}
      }

      const response = await originalFetch(...args);

      if (isMoisesApiUrl(requestUrl)) {
        let responseText = null;
        let responseJson = null;
        try {
          const cloned = response.clone();
          responseText = await cloned.text();
          try {
            responseJson = JSON.parse(responseText);
          } catch (_) {
            responseJson = null;
          }
        } catch (error) {
          postNetworkEvent({
            channel: "fetch",
            url: requestUrl,
            method,
            status: response.status,
            requestBody: parseBody(requestBody),
            error: error?.message || "Failed to clone fetch response",
          });
          return response;
        }

        postNetworkEvent({
          channel: "fetch",
          url: requestUrl,
          method,
          status: response.status,
          requestBody: parseBody(requestBody),
          responseText: safePreview(responseText, 2500),
          responseJson,
        });
      }

      return response;
    };
  };

  const hookXhr = () => {
    if (typeof XMLHttpRequest === "undefined") return;
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__moisesHook = {
        method: String(method || "GET").toUpperCase(),
        url: String(url || ""),
        requestBody: null,
      };
      return open.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(body) {
      if (this.__moisesHook) {
        this.__moisesHook.requestBody = parseBody(body);
        this.addEventListener("loadend", () => {
          if (!isMoisesApiUrl(this.__moisesHook.url)) return;
          const responseText = (() => {
            try {
              return this.responseType === "json" ? JSON.stringify(this.response) : String(this.responseText || "");
            } catch (_) {
              return null;
            }
          })();
          let responseJson = null;
          if (responseText) {
            try {
              responseJson = JSON.parse(responseText);
            } catch (_) {}
          }

          postNetworkEvent({
            channel: "xhr",
            url: this.__moisesHook.url,
            method: this.__moisesHook.method,
            status: this.status,
            requestBody: this.__moisesHook.requestBody,
            responseText: safePreview(responseText, 2500),
            responseJson,
          });
        });
      }
      return send.call(this, body);
    };
  };

  try {
    hookFetch();
    hookXhr();
    postNetworkEvent({
      channel: "bootstrap",
      url: location.href,
      method: "BOOTSTRAP",
      status: 0,
    });
  } catch (error) {
    postNetworkEvent({
      channel: "bootstrap",
      url: location.href,
      method: "BOOTSTRAP",
      status: 0,
      error: error?.message || String(error),
    });
  }
})();