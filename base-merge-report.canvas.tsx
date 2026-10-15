import {
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Stack,
  Stat,
  Table,
  Text,
  Callout,
  Timeline,
} from 'qoder/canvas';

export default function BaseMergeReport() {
  return (
    <Stack gap={20}>
      <H1>Base 工程合并报告</H1>
      <Text tone="secondary">
        将 qq-farm-bot-base 的 Activity Windows 系统合并到 qq-farm-bot，排除单用户体系改动。
      </Text>

      <Divider />

      <Grid columns={4} gap={16}>
        <Stat value="7" label="修改/新增文件" />
        <Stat value="3" label="新增模块" />
        <Stat value="6/6" label="步骤完成" tone="success" />
        <Stat value="0" label="编译错误" tone="success" />
      </Grid>

      <Callout tone="success">
        合并成功 — Activity Windows 系统已完整集成，多用户体系保持不变，TypeScript 编译零错误。
      </Callout>

      <Divider />

      <H2>新增文件</H2>
      <Table
        headers={['文件路径', '说明']}
        rows={[
          ['core/src/config/sell-conditions.ts', '出售条件评估引擎 — 解析 sell_cond 字符串，判断活动/过期条件'],
          ['core/src/services/activity-windows.ts', '活动时间窗口管理 — 缓存活动列表，提供 SellConditionContext'],
          ['core/src/services/activity-gameplay-registry.ts', '活动玩法绑定 — stellar 映射到 travel/constellation/shop/solar'],
        ]}
      />

      <H2>修改文件</H2>
      <Table
        headers={['文件路径', '改动内容']}
        rows={[
          ['core/src/core/worker.ts', '添加 refreshActivityWindows 导入与启动调用'],
          ['core/src/config/gameConfig.ts', '添加 isSellConditionSatisfied，修改 getEffectiveSellInfo 支持条件评估'],
          ['core/src/services/warehouse.ts', '传递 SellConditionContext 到 sellItems / getBagDetail / sellAllFruits'],
          ['core/src/services/activity-center.ts', '新增 buildActivityDirectory()，集成 getActivityWindows() 到快照查询'],
        ]}
      />

      <Divider />

      <H2>执行时间线</H2>
      <Timeline
        events={[
          { title: 'Step 1', description: '复制 3 个新文件 + 文档 + 20 个种子图片', tone: 'success' },
          { title: 'Step 2', description: '修改 worker.ts — 添加 refreshActivityWindows 启动调用', tone: 'success' },
          { title: 'Step 3', description: '修改 gameConfig.ts — 添加出售条件评估逻辑', tone: 'success' },
          { title: 'Step 4', description: '修改 warehouse.ts — 传递 sell condition context', tone: 'success' },
          { title: 'Step 5', description: '修改 activity-center.ts — 集成活动窗口到快照', tone: 'success' },
          { title: 'Step 6', description: '编译验证 — npx tsc --noEmit 零错误通过', tone: 'success' },
        ]}
      />

      <Divider />

      <H2>排除内容</H2>
      <Text tone="secondary">
        以下 base 中的单用户体系改动已正确排除，保持当前工程的多用户实现：
      </Text>
      <Table
        headers={['排除文件/模块', '原因']}
        rows={[
          ['admin-store.ts / auth-security.ts', '单用户管理员存储，当前工程使用 user-store/ 多用户模块'],
          ['auth-routes.ts', 'base 简单登录，当前有注册/卡密/续费'],
          ['middleware.ts', 'base 简单 token 校验，当前有用户状态检查 + 账号访问控制'],
          ['context.ts / socket.ts / index.ts', 'base 无用户隔离，当前有 tokenUserMap + 清理定时器'],
          ['web/Login.vue / App.vue / main.ts', 'base 简单登录页，当前有完整多用户路由守卫'],
        ]}
      />

      <Divider />

      <H3>验证结果</H3>
      <Grid columns={2} gap={16}>
        <Stat value="PASS" label="TypeScript 编译" tone="success" />
        <Stat value="PASS" label="全部 6 步骤完成" tone="success" />
      </Grid>
    </Stack>
  );
}
