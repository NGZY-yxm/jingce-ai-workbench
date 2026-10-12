import { stopSharedStudio } from './share/stop-studio.mjs';
try {
  const result = await stopSharedStudio();
  console.log(result.stopped ? '工作台已停止。' : result.reason === 'shutdown_pending'
    ? '已发送停止请求，请稍后检查工作台。'
    : '工作台未运行，或运行记录与服务不一致。可以关闭启动窗口停止服务。');
} catch { console.log('无法连接这一份工作台。可以关闭启动窗口停止服务。'); }
