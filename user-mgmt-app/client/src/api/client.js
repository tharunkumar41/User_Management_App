import axios from 'axios';

const api = axios.create({ baseURL: '/api', withCredentials: true });

// Normalises server errors into { message, fieldErrors, code, email }.
export function parseError(err) {
  const data = err.response?.data;
  return {
    message: data?.message || 'Could not reach the server. Check your connection and try again.',
    fieldErrors: data?.errors || {},
    code: data?.code,
    email: data?.email,
  };
}

// Downloads a file from an authenticated endpoint (CSV, PDF...).
export async function downloadFile(path, params, filename) {
  try {
    const res = await api.get(path, { params, responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    let message = 'Download failed. Please try again.';
    const body = err.response?.data;
    if (body instanceof Blob) {
      try { message = JSON.parse(await body.text()).message || message; } catch { /* keep default */ }
    }
    throw new Error(message);
  }
}

export default api;
