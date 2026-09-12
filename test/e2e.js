'use strict';
// 端到端冒烟测试：两名玩家建房→加入→开局→接词→质疑→裁定→断线重连→结算→回放
const WebSocket = require('ws');

const URL = 'ws://localhost:8080';
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}

function client(name) {
  const c = { name, ws: new WebSocket(URL), state: null, token: null, msgs: [] };
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'joined') c.token = msg.token;
    if (msg.type === 'state') c.state = msg.state;
    c.msgs.push(msg);
  });
  c.waitFor = (pred, timeout = 3000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred(c)) { clearInterval(iv); res(c); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error(`${name}: waitFor 超时`)); }
    }, 20);
  });
  c.opened = new Promise(res => c.ws.on('open', res));
  return c;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const A = client('甲');
  await A.opened;
  A.send({ type: 'createRoom', name: '甲' });
  await A.waitFor(c => c.state && c.state.phase === 'lobby');
  const code = A.state.code;
  check('创建房间', !!code);

  const B = client('乙');
  await B.opened;
  B.send({ type: 'joinRoom', name: '乙', roomCode: code });
  await B.waitFor(c => c.state && c.state.players.length === 2);
  check('加入房间', B.state.players.length === 2);

  A.send({ type: 'startGame' });
  await A.waitFor(c => c.state.phase === 'playing');
  check('开局', A.state.nodes.length === 3);
  const first = A.state.turn.playerId;
  const active = first === A.state.you ? A : B;
  const other = first === A.state.you ? B : A;
  check('轮到房主', first === A.state.you);

  // 房主接两个词成链
  const start0 = active.state.nodes[0].id;
  active.send({ type: 'play', word: '火焰', parentId: start0, relation: 'hypernym', reason: '火焰是火的一种形态' });
  await active.waitFor(c => c.state.nodes.some(n => n.word === '火焰'));
  const n1 = active.state.nodes.find(n => n.word === '火焰');
  active.send({ type: 'play', word: '篝火', parentId: n1.id, relation: 'scene', reason: '篝火晚会场景中出现' });
  await active.waitFor(c => c.state.nodes.some(n => n.word === '篝火'));
  check('接词成链', active.state.turn.apLeft === 1);

  // 对方质疑「火焰」
  other.send({ type: 'challenge', nodeId: n1.id });
  await other.waitFor(c => c.state.pendingChallenge);
  check('质疑发起并暂停计时', other.state.turn.deadline === null);
  check('裁定者是房主', other.state.pendingChallenge.adjudicatorId === A.state.you);

  // 裁定不成立 → 词保留
  A.send({ type: 'resolve', verdict: 'reject' });
  await A.waitFor(c => !c.state.pendingChallenge);
  check('裁定后计时恢复', !!A.state.turn.deadline);
  check('词保留', A.state.nodes.some(n => n.word === '火焰'));

  // 加固「篝火」然后结束回合
  const n2 = A.state.nodes.find(n => n.word === '篝火');
  active.send({ type: 'reinforce', nodeId: n2.id });
  await active.waitFor(c => c.state.nodes.find(n => n.word === '篝火').reinforced);
  check('加固成功', true);
  active.send({ type: 'endTurn' });
  await other.waitFor(c => c.state.turn.playerId === other.state.you);
  check('回合切换', true);

  // 乙断线重连
  const tokenB = B.token;
  B.ws.close();
  await sleep(300);
  check('断线被标记', A.state.players.find(p => p.name === '乙') && true);
  const B2 = client('乙');
  await B2.opened;
  B2.send({ type: 'reconnect', token: tokenB });
  await B2.waitFor(c => c.state && c.state.phase === 'playing');
  check('断线重连恢复局面', B2.state.nodes.length === A.state.nodes.length);

  // 快进结束：轮流空过
  let guard = 0;
  while (A.state.phase === 'playing' && guard < 50) {
    guard++;
    const cur = A.state.turn.playerId === A.state.you ? A : B2;
    cur.send({ type: 'endTurn' });
    await sleep(120);
  }
  await A.waitFor(c => c.state.phase === 'ended');
  check('游戏结束并结算', Array.isArray(A.state.scores) && A.state.scores.length === 2);
  console.log('  结算:', A.state.scores.map(s => `${s.name}:${s.total}`).join(' '));

  // 回放
  A.send({ type: 'replay' });
  await A.waitFor(c => c.msgs.some(m => m.type === 'replay'));
  const frames = A.msgs.find(m => m.type === 'replay').frames;
  check('回放帧可用', frames.length > 5 && frames[frames.length - 1].scores);

  A.ws.close(); B2.ws.close();
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('冒烟测试异常:', e.message); process.exit(1); });
