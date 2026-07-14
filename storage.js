const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI || '';

const DEFAULT_CONFIG = { biweeklyFridayRef: null, adminPinHash: null, testMode: false };

let impl;

if (MONGODB_URI) {
  // ---------- MongoDB Atlas 백엔드 (배포 환경, 데이터 영구 보존) ----------
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(MONGODB_URI);
  let collectionPromise = null;

  async function getCollection() {
    if (!collectionPromise) {
      collectionPromise = client.connect().then(() => {
        const dbName = process.env.MONGODB_DB || 'yoga_signup';
        return client.db(dbName).collection('appdata');
      });
    }
    return collectionPromise;
  }

  impl = {
    async getSessions() {
      const col = await getCollection();
      const doc = await col.findOne({ _id: 'sessions' });
      return doc ? doc.value : [];
    },
    async saveSessions(data) {
      const col = await getCollection();
      await col.updateOne({ _id: 'sessions' }, { $set: { value: data } }, { upsert: true });
    },
    async getPushSubscriptions() {
      const col = await getCollection();
      const doc = await col.findOne({ _id: 'pushSubscriptions' });
      return doc ? doc.value : [];
    },
    async savePushSubscriptions(data) {
      const col = await getCollection();
      await col.updateOne({ _id: 'pushSubscriptions' }, { $set: { value: data } }, { upsert: true });
    },
    async getConfig() {
      const col = await getCollection();
      const doc = await col.findOne({ _id: 'config' });
      return doc ? doc.value : { ...DEFAULT_CONFIG };
    },
    async saveConfig(data) {
      const col = await getCollection();
      await col.updateOne({ _id: 'config' }, { $set: { value: data } }, { upsert: true });
    }
  };

  console.log('저장소: MongoDB Atlas 사용 (영구 저장)');
} else {
  // ---------- 로컬 파일 백엔드 (MONGODB_URI 없을 때, 로컬 개발/테스트용) ----------
  const DATA_DIR = path.join(__dirname, 'data');
  const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
  const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
  const PUSH_SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'push-subscriptions.json');

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '[]');
  if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
  if (!fs.existsSync(PUSH_SUBSCRIPTIONS_FILE)) fs.writeFileSync(PUSH_SUBSCRIPTIONS_FILE, '[]');

  impl = {
    async getSessions() { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); },
    async saveSessions(data) { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2)); },
    async getPushSubscriptions() { return JSON.parse(fs.readFileSync(PUSH_SUBSCRIPTIONS_FILE, 'utf8')); },
    async savePushSubscriptions(data) { fs.writeFileSync(PUSH_SUBSCRIPTIONS_FILE, JSON.stringify(data, null, 2)); },
    async getConfig() { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); },
    async saveConfig(data) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2)); }
  };

  console.log('저장소: 로컬 파일 사용 (개발용 — 배포 시 MONGODB_URI를 설정하면 Atlas로 전환됩니다)');
}

module.exports = impl;
