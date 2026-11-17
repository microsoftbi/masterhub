<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const module = computed(() => String(route.params.module || ''));

const INFO: Record<string, any> = {
  quality: {
    name: '数据质量',
    desc: '质量规则配置、自动稽核任务、问题工单与整改闭环',
    items: ['规则模板：非空/唯一/枚举/正则/跨域引用完整性', '定时稽核任务与得分趋势', '问题数据工单流转与整改验证'],
  },
  workflow: {
    name: '工作流编排',
    desc: '类 Alteryx 的拖拽式可视化编排与调度',
    items: ['节点库：数据源、过滤、连接、聚合、输出', '画布拖拽连线与运行日志', '调度策略与依赖编排'],
  },
  dashboard: {
    name: '仪表板',
    desc: '类 Power BI 的自助分析与可视化大屏',
    items: ['多数据源数据集与指标建模', '图表组件与联动钻取', '看板分享与订阅推送'],
  },
};
const info = computed(() => INFO[module.value] || { name: '规划中', desc: '该模块将在 M2 迭代交付', items: [] });
</script>

<template>
  <div class="wrap">
    <div class="page-head">
      <div>
        <h2>{{ info.name }}</h2>
        <p class="desc">{{ info.desc }}</p>
      </div>
      <span class="tag o">M2 规划</span>
    </div>

    <div class="card">
      <div class="card-body">
        <p class="muted">当前为 M1 交付范围（模型/码表/编码、主数据维护、导入、审批、集成分发、系统管理），以下能力将在 M2（PostgreSQL 迁移同期）实施：</p>
        <div class="tl mt10">
          <div v-for="(it, i) in info.items" :key="i" class="tl-item">
            <b>{{ i + 1 }}. {{ it }}</b>
          </div>
          <p v-if="!info.items.length" class="hint">暂无详细规划</p>
        </div>
      </div>
    </div>
  </div>
</template>
