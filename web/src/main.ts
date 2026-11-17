import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import * as Icons from '@element-plus/icons-vue';
import App from './App.vue';
import router from './router';
import './styles.css';

const app = createApp(App);
for (const [name, comp] of Object.entries(Icons)) app.component(name, comp as any);
app.use(createPinia());
app.use(router);
app.use(ElementPlus);
app.mount('#app');
