#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptCandidateHabit, enableHabit, lawSnapshotForTest, listApprovedPendingHabitsForSetup, readConfiguredLawSnapshot } from '../extensions/agent-experience/src/review.ts';
import { promoteApprovedPendingCandidates } from '../extensions/agent-experience/src/selector.ts';
import { MAX_SEMANTIC_SCAN_HABITS, scanAndBackfillSemanticDuplicates } from '../extensions/agent-experience/src/semantic/service.ts';
import { listHabitDuplicates } from '../extensions/agent-experience/src/semantic/storage.ts';
import { ensurePrivateRoot } from '../extensions/agent-experience/src/storage/private-root.ts';
import { buildTypedStorageRow, initExperienceStorage, insertStorageRecord, openExistingExperienceStorage } from '../extensions/agent-experience/src/storage/sqlite.ts';

const policy = {enabled:true, provider:'fixture-local', model:'fixture-v1', dimensions:2, reviewThresholdBp:7500, strongThresholdBp:8500, timeoutMs:5000};
const unit = Float32Array.from([1, 0]);
const orthogonal = Float32Array.from([0, 1]);
function refs(prefix='a') { return [1,2,3].map((seq) => ({file_generation:'g', seq, checksum:`${prefix.repeat(64).slice(0,63)}${seq}`})); }
function eligibleData(condition, behavior, overrides={}) { return {schema_version:2, record_kind:'candidate_habit_v1', status:'candidate', active:false, injectable:false, condition, behavior, polarity:1, confidence_bp:9000, source_refs:refs(), source_dates:['2026-07-01','2026-07-02','2026-07-03'], review_status:'candidate', ...overrides}; }
function semanticDigest(db) {
  const tables=['habit_embeddings','habit_duplicates','habit_duplicate_audit'];
  return JSON.stringify(Object.fromEntries(tables.map((table)=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}
function barrierProvider(expected=2) {
  let arrivals=0; let release;
  const gate=new Promise((resolve)=>{release=resolve});
  return {id:'fixture-local:fixture-v1:2',provider:'fixture-local',model:'fixture-v1',dimensions:2,async embed(texts){arrivals+=1;if(arrivals===expected)release();if(arrivals<=expected)await gate;return texts.map(()=>unit.slice());},get arrivals(){return arrivals}};
}
const temp=await mkdtemp(join(tmpdir(),'pi-experience-semantic-atomic-'));
try {
  // Two independent SQLite connections: concurrent approvals can activate only one semantic duplicate.
  const root=await ensurePrivateRoot(join(temp,'accept'));
  const one=await initExperienceStorage(root,{allowInit:true,userId:'owner'});
  insertStorageRecord(one.db,'habits',{id:'candidate-a',userId:'owner',data:eligibleData('When reviewing a release','Run every validation before publishing.'),now:'2026-07-10T00:00:00.000Z'});
  insertStorageRecord(one.db,'habits',{id:'candidate-b',userId:'owner',data:eligibleData('Before publishing a release','Execute the complete validation suite.'),now:'2026-07-10T00:00:01.000Z'});
  const two=await openExistingExperienceStorage(root,{userId:'owner'});
  try {
    const a=one.db.prepare("SELECT checksum FROM habits WHERE id='candidate-a'").get();
    const b=two.db.prepare("SELECT checksum FROM habits WHERE id='candidate-b'").get();
    const provider=barrierProvider();
    const [left,right]=await Promise.all([
      acceptCandidateHabit(one.db,{userId:'owner',habitId:'candidate-a',checksum:a.checksum,law:lawSnapshotForTest(),now:'2026-07-10T00:01:00.000Z',semantic:{policy,provider}}),
      acceptCandidateHabit(two.db,{userId:'owner',habitId:'candidate-b',checksum:b.checksum,law:lawSnapshotForTest(),now:'2026-07-10T00:01:01.000Z',semantic:{policy,provider}}),
    ]);
    assert.equal([left,right].filter((item)=>item.activated).length,1,'exactly one concurrent duplicate approval may activate');
    const states=one.db.prepare("SELECT status,data_json FROM habits ORDER BY id").all();
    assert.equal(states.filter((row)=>row.status==='active').length,1);
    assert.equal(states.filter((row)=>row.status==='candidate').length,1);
    assert.ok(states.some((row)=>JSON.parse(row.data_json).approved_identity),'blocked duplicate must retain prior explicit approval identity');
    assert.equal(listHabitDuplicates(one.db,{userId:'owner',decision:'pending'}).length,1);
  } finally { two.db.close(); one.db.close(); }

  // Two-connection re-enable path also prevents duplicate activation.
  const enableRoot=await ensurePrivateRoot(join(temp,'enable'));
  const e1=await initExperienceStorage(enableRoot,{allowInit:true,userId:'owner'});
  for(const id of ['disabled-a','disabled-b']) insertStorageRecord(e1.db,'habits',{id,userId:'owner',data:eligibleData('When preparing a release','Validate the complete installable artifact.',{status:'disabled',review_status:'accepted_active'}),now:'2026-07-10T00:30:00.000Z'});
  const e2=await openExistingExperienceStorage(enableRoot,{userId:'owner'});
  try {
    const a=e1.db.prepare("SELECT checksum FROM habits WHERE id='disabled-a'").get();
    const b=e2.db.prepare("SELECT checksum FROM habits WHERE id='disabled-b'").get();
    const provider=barrierProvider();
    const [left,right]=await Promise.all([
      enableHabit(e1.db,{userId:'owner',habitId:'disabled-a',checksum:a.checksum,law:lawSnapshotForTest(),now:'2026-07-10T00:31:00.000Z',semantic:{policy,provider}}),
      enableHabit(e2.db,{userId:'owner',habitId:'disabled-b',checksum:b.checksum,law:lawSnapshotForTest(),now:'2026-07-10T00:31:01.000Z',semantic:{policy,provider}}),
    ]);
    assert.ok([left,right].filter((item)=>item.enabled).length<=1,'concurrent duplicate re-enable must activate at most one habit');
    assert.ok(e1.db.prepare("SELECT COUNT(*) count FROM habits WHERE status='active'").get().count<=1);
  } finally { e2.db.close(); e1.db.close(); }

  // Concurrent promotion uses the same barrier and preserves prior approvals.
  const promotionRoot=await ensurePrivateRoot(join(temp,'promotion'));
  const p1=await initExperienceStorage(promotionRoot,{allowInit:true,userId:'owner'});
  for (const id of ['pending-a','pending-b']) insertStorageRecord(p1.db,'habits',{id,userId:'owner',data:eligibleData('When validating a package','Run all checks on the installable artifact.',{review_status:'approved_pending_eligibility',approved_identity:{candidate_id:id,condition:'when validating a package',behavior:'run all checks on the installable artifact.',polarity:1,approved_at:'2026-07-09T00:00:00.000Z'}}),now:'2026-07-10T01:00:00.000Z'});
  const p2=await openExistingExperienceStorage(promotionRoot,{userId:'owner'});
  try {
    const provider=barrierProvider();
    const [r1,r2]=await Promise.all([
      promoteApprovedPendingCandidates(p1.db,{userId:'owner',law:lawSnapshotForTest(),now:'2026-07-10T01:01:00.000Z',semantic:{policy,provider},candidateIdsForTest:['pending-a']}),
      promoteApprovedPendingCandidates(p2.db,{userId:'owner',law:lawSnapshotForTest(),now:'2026-07-10T01:01:01.000Z',semantic:{policy,provider},candidateIdsForTest:['pending-b']}),
    ]);
    assert.equal(r1.promoted.length+r2.promoted.length,1,'concurrent promotion may activate only one duplicate');
    assert.equal(p1.db.prepare("SELECT COUNT(*) count FROM habits WHERE status='active'").get().count,1);
  } finally { p2.db.close(); p1.db.close(); }

  // Approved-but-waiting records remain visible and promote automatically once evidence becomes eligible.
  const waitingRoot=await ensurePrivateRoot(join(temp,'waiting'));
  const waiting=await initExperienceStorage(waitingRoot,{allowInit:true,userId:'owner'});
  try {
    const inserted=insertStorageRecord(waiting.db,'habits',{id:'waiting-one',userId:'owner',data:eligibleData('When preparing a handoff','Include the current status and next action.',{source_refs:refs().slice(0,2),source_dates:['2026-07-01']}),now:'2026-07-10T02:00:00.000Z'});
    const approved=await acceptCandidateHabit(waiting.db,{userId:'owner',habitId:'waiting-one',checksum:inserted.checksum,law:lawSnapshotForTest(),now:'2026-07-10T02:01:00.000Z',semantic:{policy:{...policy,enabled:false}}});
    assert.equal(approved.activated,false);
    assert.equal(listApprovedPendingHabitsForSetup(waiting.db,{userId:'owner'}).length,1,'approved pending candidate must be setup-visible');
    const before=waiting.db.prepare("SELECT * FROM habits WHERE id='waiting-one'").get();
    const data={...JSON.parse(before.data_json),record_kind:before.record_kind,schema_version:before.schema_version,status:before.status,condition:before.condition,behavior:before.behavior,polarity:before.polarity,confidence_bp:before.confidence_bp,activation:before.activation,staleness:before.staleness,source_refs:refs(),source_dates:['2026-07-01','2026-07-02','2026-07-03']};
    const updated=buildTypedStorageRow('habits',{id:before.id,userId:'owner',data,createdAt:before.created_at,updatedAt:'2026-07-10T02:02:00.000Z'});
    waiting.db.prepare("UPDATE habits SET record_kind=?,schema_version=?,status=?,habit_id=?,condition=?,behavior=?,polarity=?,confidence_bp=?,activation=?,staleness=?,data_json=?,checksum=?,updated_at=? WHERE id=? AND checksum=?").run(updated.record_kind,updated.schema_version,updated.status,updated.habit_id,updated.condition,updated.behavior,updated.polarity,updated.confidence_bp,updated.activation,updated.staleness,updated.data_json,updated.checksum,updated.updated_at,before.id,before.checksum);
    const waitingBeforePromotion=waiting.db.prepare("SELECT id,condition,behavior,polarity,data_json FROM habits WHERE id='waiting-one'").get();
    const waitingApproval=JSON.parse(waitingBeforePromotion.data_json).approved_identity;
    assert.deepEqual({candidate_id:waitingApproval.candidate_id,condition:waitingApproval.condition,behavior:waitingApproval.behavior,polarity:Number(waitingApproval.polarity)},{candidate_id:waitingBeforePromotion.id,condition:String(waitingBeforePromotion.condition).trim().replace(/\s+/g,' ').toLowerCase(),behavior:String(waitingBeforePromotion.behavior).trim().replace(/\s+/g,' ').toLowerCase(),polarity:Number(waitingBeforePromotion.polarity)});
    const promoted=await promoteApprovedPendingCandidates(waiting.db,{userId:'owner',law:lawSnapshotForTest(),now:'2026-07-10T02:03:00.000Z',semantic:{policy:{...policy,enabled:false}}});
    assert.deepEqual(promoted.promoted,['waiting-one'],JSON.stringify(promoted));
    assert.equal(waiting.db.prepare("SELECT status FROM habits WHERE id='waiting-one'").get().status,'active');
  } finally { waiting.db.close(); }

  // Law is synchronously revalidated at the writer boundary.
  const lawRoot=await ensurePrivateRoot(join(temp,'law-race'));
  await writeFile(join(lawRoot,'law.md'),'safe law\n',{mode:0o600});
  const lawStorage=await initExperienceStorage(lawRoot,{allowInit:true,userId:'owner'});
  try {
    const row=insertStorageRecord(lawStorage.db,'habits',{id:'law-candidate',userId:'owner',data:eligibleData('When reviewing changes','Respect current safety instructions.'),now:'2026-07-10T03:00:00.000Z'});
    const snapshot=await readConfiguredLawSnapshot(lawRoot,{law_path:'law.md'});
    await writeFile(join(lawRoot,'law.md'),'changed law\n',{mode:0o600});
    await assert.rejects(()=>acceptCandidateHabit(lawStorage.db,{userId:'owner',habitId:row.id,checksum:row.checksum,law:snapshot,now:'2026-07-10T03:01:00.000Z',semantic:{policy:{...policy,enabled:false}}}),/changed/);
    assert.equal(lawStorage.db.prepare("SELECT status FROM habits WHERE id='law-candidate'").get().status,'candidate');
  } finally { lawStorage.db.close(); }

  // Scan is bounded, batched, cancellable, snapshot-checked, and all-or-nothing.
  const scanRoot=await ensurePrivateRoot(join(temp,'scan'));
  const scan=await initExperienceStorage(scanRoot,{allowInit:true,userId:'owner'});
  try {
    const poison='RAW_EXAMPLE source=/private/path token=secret-value checksum=abcdef';
    for(let index=0;index<6;index+=1) insertStorageRecord(scan.db,'habits',{id:`scan-${index}`,userId:'owner',data:eligibleData(`When task ${index%2}`,'Use the same careful validation behavior.',{status:index<2?'active':'candidate',data_poison:poison}),now:`2026-07-10T04:00:0${index}.000Z`});
    const calls=[];const progress=[];
    const provider={id:'fixture-local:fixture-v1:2',provider:'fixture-local',model:'fixture-v1',dimensions:2,async embed(texts){calls.push(texts.slice());return texts.map(()=>unit.slice())}};
    const result=await scanAndBackfillSemanticDuplicates(scan.db,{userId:'owner',policy,provider,now:'2026-07-10T04:01:00.000Z',batchSize:2,onProgress:(item)=>progress.push(item)});
    assert.equal(result.checked,6);
    assert.deepEqual(calls.map((batch)=>batch.length),[2,2,2],'scan must batch missing embeddings');
    assert.ok(calls.flat().every((text)=>!text.includes(poison)&&text.split('\n').length===2),'embedding payload must contain only normalized condition plus behavior');
    assert.ok(progress.some((item)=>item.phase==='embedding')&&progress.some((item)=>item.phase==='comparing')&&progress.some((item)=>item.phase==='saving')&&progress.some((item)=>item.phase==='done'));
    const durableJson=JSON.stringify({relations:scan.db.prepare('SELECT data_json FROM habit_duplicates').all(),audit:scan.db.prepare('SELECT data_json FROM habit_duplicate_audit').all()});
    assert.doesNotMatch(durableJson,/RAW_EXAMPLE|private\/path|secret-value|abcdef/,'vector relation/audit metadata must not contain raw/residual/private payload');

    const failRoot=await ensurePrivateRoot(join(temp,'scan-fail'));
    const fail=await initExperienceStorage(failRoot,{allowInit:true,userId:'owner'});
    try {
      for(let i=0;i<3;i+=1)insertStorageRecord(fail.db,'habits',{id:`fail-${i}`,userId:'owner',data:eligibleData(`When f${i}`,'Do the same action.'),now:`2026-07-10T05:00:0${i}.000Z`});
      const before=semanticDigest(fail.db);
      await assert.rejects(()=>scanAndBackfillSemanticDuplicates(fail.db,{userId:'owner',policy,provider,now:'2026-07-10T05:01:00.000Z',failAfterWritesForTest:true}),/injected_semantic_scan_write_failure/);
      assert.equal(semanticDigest(fail.db),before,'write failure must roll back embeddings, relations, and audit');
      const controller=new AbortController();
      const cancelling={...provider,async embed(texts){controller.abort(new Error('cancelled-by-test'));return texts.map(()=>unit.slice())}};
      await assert.rejects(()=>scanAndBackfillSemanticDuplicates(fail.db,{userId:'owner',policy,provider:cancelling,now:'2026-07-10T05:02:00.000Z',batchSize:1,signal:controller.signal}),/cancelled-by-test/);
      assert.equal(semanticDigest(fail.db),before,'cancellation must leave pre-scan semantic state unchanged');
      const failing={...provider,async embed(){throw new Error('fixture-runtime-failure')}};
      await assert.rejects(()=>scanAndBackfillSemanticDuplicates(fail.db,{userId:'owner',policy,provider:failing,now:'2026-07-10T05:03:00.000Z'}),/fixture-runtime-failure/);
      assert.equal(semanticDigest(fail.db),before,'runtime failure must leave pre-scan semantic state unchanged');
      await assert.rejects(()=>scanAndBackfillSemanticDuplicates(fail.db,{userId:'owner',policy,provider,now:'2026-07-10T05:04:00.000Z',beforeCommitForTest:()=>insertStorageRecord(fail.db,'habits',{id:'external-change',userId:'owner',data:eligibleData('When external','Change snapshot.'),now:'2026-07-10T05:03:59.000Z'})}),/state changed/);
      assert.equal(fail.db.prepare('SELECT COUNT(*) count FROM habit_embeddings').get().count,0,'snapshot drift must not persist staged vectors');
    } finally { fail.db.close(); }
  } finally { scan.db.close(); }

  const capRoot=await ensurePrivateRoot(join(temp,'scan-cap'));
  const cap=await initExperienceStorage(capRoot,{allowInit:true,userId:'owner'});
  try {
    for(let i=0;i<MAX_SEMANTIC_SCAN_HABITS+1;i+=1)insertStorageRecord(cap.db,'habits',{id:`cap-${i}`,userId:'owner',data:eligibleData(`When cap ${i}`,`Do bounded ${i}.`),now:'2026-07-10T06:00:00.000Z'});
    let called=false;const provider={id:'fixture-local:fixture-v1:2',provider:'fixture-local',model:'fixture-v1',dimensions:2,async embed(){called=true;return [orthogonal]}};
    await assert.rejects(()=>scanAndBackfillSemanticDuplicates(cap.db,{userId:'owner',policy,provider,now:'2026-07-10T06:01:00.000Z'}),/limited to 100/);
    assert.equal(called,false,'scan cap must reject before embedding work');
  } finally { cap.db.close(); }
} finally { await rm(temp,{recursive:true,force:true}); }
console.log('agent-experience phase14 semantic atomicity checks passed');
