<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '../stores/auth';

const auth = useAuth();
const router = useRouter();
const username = ref('admin');
const password = ref('admin123');
const loading = ref(false);

const accounts = [
  { u: 'admin', p: 'admin123', label: '平台管理员' },
  { u: 'steward', p: 'steward123', label: '数据治理岗' },
  { u: 'leader', p: 'leader123', label: '部门负责人' },
  { u: 'buyer', p: 'buyer123', label: '采购专员' },
];

async function submit() {
  if (!username.value || !password.value) return;
  loading.value = true;
  try {
    await auth.login(username.value, password.value);
    router.push('/');
  } catch { /* 拦截器已提示 */ } finally {
    loading.value = false;
  }
}

function fill(u: string, p: string) {
  username.value = u;
  password.value = p;
}
</script>

<template>
  <div class="login">
    <div class="brand">
      <div class="brand-inner">
        <div class="b-logo">Master<b>Hub</b></div>
        <div class="b-sub">主数据管理系统</div>
        <div class="b-desc">元数据驱动的统一主数据治理平台：模型、标准、审批、分发一体化。</div>
        <div class="b-list">
          <div>· 新主数据域零编码上线</div>
          <div>· 编码规则与生命周期自动管控</div>
          <div>· 审批通过后自动生效并分发订阅方</div>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="box">
        <h2>账号登录</h2>
        <p class="muted">使用平台账号进入主数据工作台</p>
        <el-form label-position="top" @submit.prevent>
          <el-form-item label="账号">
            <el-input v-model="username" size="large" placeholder="请输入账号" @keyup.enter="submit" />
          </el-form-item>
          <el-form-item label="密码">
            <el-input v-model="password" type="password" size="large" show-password placeholder="请输入密码" @keyup.enter="submit" />
          </el-form-item>
          <button class="btn primary login-btn" :disabled="loading" @click="submit">
            {{ loading ? '登录中…' : '登 录' }}
          </button>
        </el-form>
        <div class="hint-title">演示账号</div>
        <div class="accounts">
          <span v-for="a in accounts" :key="a.u" class="acc" @click="fill(a.u, a.p)">
            {{ a.label }} <b>{{ a.u }}</b>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login { display: grid; grid-template-columns: 1.1fr 1fr; height: 100%; background: #fff; }
.brand { background: radial-gradient(1200px 600px at 10% 10%, #1e3a8a, #0f172a 60%); color: #e2e8f0; display: flex; align-items: center; padding: 60px; }
.brand-inner { max-width: 520px; }
.b-logo { font-size: 34px; font-weight: 800; letter-spacing: .5px; }
.b-logo b { color: #60a5fa; }
.b-sub { font-size: 16px; color: #94a3b8; margin-top: 4px; }
.b-desc { margin-top: 26px; font-size: 14px; line-height: 1.9; color: #cbd5e1; }
.b-list { margin-top: 22px; font-size: 13px; color: #94a3b8; line-height: 2.1; }
.panel { display: flex; align-items: center; justify-content: center; padding: 40px; background: #f8fafc; }
.box { width: 380px; background: #fff; border: 1px solid var(--bd); border-radius: 12px; padding: 32px; box-shadow: 0 12px 40px rgba(15, 23, 42, .06); }
.box h2 { font-size: 20px; }
.box .muted { margin: 4px 0 22px; }
.login-btn { width: 100%; justify-content: center; padding: 9px 0; margin-top: 6px; font-size: 14px; }
.hint-title { margin: 22px 0 8px; font-size: 12px; color: var(--mut); }
.accounts { display: flex; flex-wrap: wrap; gap: 8px; }
.acc { border: 1px dashed var(--bd); border-radius: 6px; padding: 4px 8px; font-size: 12px; cursor: pointer; color: var(--mut); }
.acc b { color: var(--p); font-weight: 500; }
.acc:hover { border-color: var(--p); background: #f8fbff; }
@media (max-width: 900px) { .login { grid-template-columns: 1fr; } .brand { display: none; } }
</style>
