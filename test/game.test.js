'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../game');

function makeRoom(playerNames = ['甲', '乙', '丙']) {
  const room = g.newRoom('TEST', 'p0', playerNames[0]);
  playerNames.forEach((n, i) => g.addPlayer(room, `p${i}`, n));
  const err = g.startGame(room, 'p0', () => 0.01); // 固定随机数，起始词可预测
  assert.strictEqual(err, null);
  return room;
}

function activeId(room) { return room.turn.playerId; }

function playOk(room, word, parentId = 'start0', relation = 'synonym', reason = '这是合理的解释') {
  return g.playWord(room, activeId(room), { word, parentId, relation, reason });
}

test('开局：起始词、回合、行动点就绪', () => {
  const room = makeRoom();
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.nodes.length, room.ruleSet.startWordCount);
  assert.strictEqual(room.turn.apLeft, room.ruleSet.apPerTurn);
  assert.strictEqual(activeId(room), 'p0');
});

test('接词：扣行动点、校验重复词与解释长度', () => {
  const room = makeRoom();
  assert.strictEqual(playOk(room, '开心'), null);
  assert.strictEqual(room.turn.apLeft, room.ruleSet.apPerTurn - 1);
  assert.strictEqual(playOk(room, '开心'), '这个词已经在场上了');
  const err = g.playWord(room, activeId(room), { word: '高兴', parentId: 'start0', relation: 'synonym', reason: '短' });
  assert.match(err, /至少/);
});

test('接词：不允许的关系类型被拒绝', () => {
  const room = makeRoom();
  room.ruleSet.allowedRelations = ['synonym'];
  const err = g.playWord(room, activeId(room), { word: '黑夜', parentId: 'start0', relation: 'antonym', reason: '足够的解释长度' });
  assert.match(err, /规则/);
});

test('回合推进与游戏结束', () => {
  const room = makeRoom(['甲', '乙']);
  const total = room.players.length * room.ruleSet.rounds;
  for (let i = 0; i < total; i++) {
    assert.strictEqual(room.phase, 'playing');
    assert.strictEqual(g.endTurn(room, activeId(room)), null);
  }
  assert.strictEqual(room.phase, 'ended');
  assert.ok(room.log.some(e => e.type === 'end'));
});

test('加固消耗行动点且免疫质疑', () => {
  const room = makeRoom(['甲', '乙']);
  playOk(room, '开心');
  const node = room.nodes.find(n => n.word === '开心');
  assert.strictEqual(g.reinforce(room, 'p0', node.id), null);
  // 质疑必须在对方（词主）的回合内发起
  assert.strictEqual(g.challenge(room, 'p1', node.id), '加固过的连接免疫质疑');
});

test('质疑成立：级联拆除未加固下游，加固下游成为新根', () => {
  const room = makeRoom(['甲', '乙']);
  // p0 建链：开心 -> 快乐；加固「快乐」（3 AP 用完）
  playOk(room, '开心');
  const n1 = room.nodes.find(n => n.word === '开心');
  playOk(room, '快乐', n1.id);
  const n2 = room.nodes.find(n => n.word === '快乐');
  g.reinforce(room, 'p0', n2.id);
  // p1 在 p0 的回合内质疑「开心」
  assert.strictEqual(g.challenge(room, 'p1', n1.id), null);
  assert.ok(room.pendingChallenge);
  assert.strictEqual(room.turn.deadline, null, '计时应暂停');
  assert.strictEqual(g.resolveChallenge(room, 'p0', 'uphold'), null);
  assert.ok(!room.nodes.some(n => n.word === '开心'), '开心应被移除');
  const happy = room.nodes.find(n => n.word === '快乐');
  assert.ok(happy, '加固的快乐应幸存');
  assert.strictEqual(happy.parentId, null, '快乐应成为新根');
  assert.ok(room.turn.deadline, '裁定后计时应恢复');
});

test('质疑不成立：词保留，质疑次数已消耗', () => {
  const room = makeRoom(['甲', '乙']);
  playOk(room, '开心');
  const n1 = room.nodes.find(n => n.word === '开心');
  const tokensBefore = room.players[1].tokensLeft;
  g.challenge(room, 'p1', n1.id);
  g.resolveChallenge(room, 'p0', 'reject');
  assert.ok(room.nodes.some(n => n.word === '开心'));
  assert.strictEqual(room.players[1].tokensLeft, tokensBefore - 1);
});

test('未加固的下游被级联拆除', () => {
  const room = makeRoom(['甲', '乙']);
  playOk(room, '开心');
  const n1 = room.nodes.find(n => n.word === '开心');
  playOk(room, '快乐', n1.id);
  playOk(room, '喜悦', room.nodes.find(n => n.word === '快乐').id);
  g.challenge(room, 'p1', n1.id);
  g.resolveChallenge(room, 'p0', 'uphold');
  for (const w of ['开心', '快乐', '喜悦']) {
    assert.ok(!room.nodes.some(n => n.word === w), `${w} 应被级联移除`);
  }
});

test('计分：长链与加固有更高收益', () => {
  const room = makeRoom(['甲', '乙']);
  // p0: 链 a->b->c（深度 0,1,2）= 1+2+3 = 6，最长链 3 → +6
  playOk(room, '甲一');
  playOk(room, '甲二', room.nodes.find(n => n.word === '甲一').id);
  playOk(room, '甲三', room.nodes.find(n => n.word === '甲二').id);
  g.endTurn(room, 'p0');
  // p1: 只接一个词 = 1 分，最长链 1 → +2
  playOk(room, '乙一');
  g.endTurn(room, 'p1');
  const scores = g.computeScores(room);
  const s0 = scores.find(s => s.playerId === 'p0');
  const s1 = scores.find(s => s.playerId === 'p1');
  assert.strictEqual(s0.total, 1 + 2 + 3 + 6);
  assert.strictEqual(s1.total, 1 + 2);
  assert.ok(s0.total > s1.total);
});

test('回放帧可从日志重建', () => {
  const room = makeRoom(['甲', '乙']);
  playOk(room, '开心');
  g.endTurn(room, 'p0');
  g.endTurn(room, 'p1');
  // 强制结束以便包含 end 帧
  while (room.phase === 'playing') g.endTurn(room, activeId(room));
  const frames = g.buildReplay(room);
  assert.ok(frames.length > 3);
  const playFrame = frames.find(f => f.label.includes('开心'));
  assert.ok(playFrame.nodes.some(n => n.word === '开心'));
  assert.ok(frames[frames.length - 1].scores, '最后一帧应有结算');
});

test('断线重连后玩家状态保留', () => {
  const room = makeRoom(['甲', '乙']);
  room.players[1].connected = false;
  room.players[1].connected = true; // 模拟重连
  assert.strictEqual(room.players[1].connected, true);
  assert.strictEqual(room.phase, 'playing');
});

test('涉及房主的质疑由其他玩家裁定', () => {
  const room = makeRoom(['甲', '乙', '丙']);
  playOk(room, '开心'); // p0（房主）的词
  const n1 = room.nodes.find(n => n.word === '开心');
  g.challenge(room, 'p1', n1.id); // p0 回合内，p1 质疑
  assert.notStrictEqual(room.pendingChallenge.adjudicatorId, 'p0');
  assert.notStrictEqual(room.pendingChallenge.adjudicatorId, 'p1', '质疑者不应裁定自己的质疑');
  assert.strictEqual(g.resolveChallenge(room, 'p0', 'uphold'), '只有裁定者可以判定');
  assert.strictEqual(g.resolveChallenge(room, room.pendingChallenge.adjudicatorId, 'uphold'), null);
});
