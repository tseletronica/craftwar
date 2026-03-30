import { http, HttpHeader, HttpRequest, HttpRequestMethod } from '@minecraft/server-net';
import { NETWORK_CONFIG } from './config.js';

const METHOD_MAP = {
  GET: HttpRequestMethod.Get,
  POST: HttpRequestMethod.Post,
  PUT: HttpRequestMethod.Put
};

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

export async function requestJson(method, path, body = null) {
  const request = new HttpRequest(normalizeBaseUrl(NETWORK_CONFIG.baseUrl) + path);
  request.method = METHOD_MAP[String(method || 'GET').toUpperCase()] || HttpRequestMethod.Get;
  request.headers = [
    new HttpHeader('Content-Type', 'application/json')
  ];

  if (body !== null && body !== undefined) {
    request.body = JSON.stringify(body);
  }

  const response = await http.request(request);

  let data = null;
  try {
    data = response.body ? JSON.parse(response.body) : null;
  } catch (error) {
    data = null;
  }

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    data,
    raw: response.body
  };
}
