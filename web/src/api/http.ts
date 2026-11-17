import axios from 'axios';
import { ElMessage } from 'element-plus';

const http = axios.create({ baseURL: '', timeout: 20000 });

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('mh_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (res) => {
    const body = res.data;
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code === 0) return body.data;
      ElMessage.error(body.msg || '请求失败');
      return Promise.reject(new Error(body.msg || '请求失败'));
    }
    return body;
  },
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('mh_token');
      if (!location.pathname.startsWith('/login')) location.href = '/login';
    }
    const msg = err.response?.data?.msg || err.message || '网络异常';
    ElMessage.error(msg);
    return Promise.reject(err);
  },
);

export default http;
