'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Nav from '@/components/Nav';
import api from '@/lib/api';

type Step = 'connect' | 'profiling' | 'done';

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep]         = useState<Step>('connect');
  const [filepath, setFilepath] = useState('');
  const [testMsg, setTestMsg]   = useState('');
  const [testOk, setTestOk]     = useState<boolean | null>(null);
  const [connId, setConnId]     = useState<number | null>(null);
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function testConnection() {
    setTestMsg('');
    setTestOk(null);
    setLoading(true);
    try {
      const res = await api.post('/connections/test', { type: 'sqlite', config: { filepath } });
      setTestOk(res.data.ok);
      setTestMsg(res.data.data?.message ?? '');
    } catch {
      setTestOk(false);
      setTestMsg('Connection failed. Check the file path.');
    } finally {
      setLoading(false);
    }
  }

  async function createAndProfile() {
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/connections', {
        name:   'sample-sqlite',
        type:   'sqlite',
        config: { filepath },
      });
      setConnId(res.data.data.connectionId);
      setStep('profiling');
      // Profiling runs in the background — wait 8s then redirect to definitions
      setTimeout(() => {
        setStep('done');
      }, 8000);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? 'Failed to create connection.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Nav />
      <div className="max-w-xl mx-auto pt-16 px-4">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">Connect your data source</h1>
        <p className="text-slate-500 text-sm mb-8">Point DataBridge to your SQLite database file to get started.</p>

        {step === 'connect' && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">SQLite file path</label>
              <input
                type="text"
                value={filepath}
                onChange={(e) => setFilepath(e.target.value)}
                placeholder="C:\Users\you\Documents\databridge\data\sample.db"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {testMsg && (
              <p className={`text-sm ${testOk ? 'text-green-600' : 'text-red-600'}`}>{testMsg}</p>
            )}

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex gap-3">
              <button
                onClick={testConnection}
                disabled={!filepath || loading}
                className="px-4 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition-colors"
              >
                Test connection
              </button>
              <button
                onClick={createAndProfile}
                disabled={!testOk || loading}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors"
              >
                Connect &amp; analyse
              </button>
            </div>
          </div>
        )}

        {step === 'profiling' && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center space-y-3">
            <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="font-medium text-slate-800">Analysing your schema…</p>
            <p className="text-sm text-slate-500">Claude is generating definitions for your tables and columns. This takes about 5–10 seconds.</p>
          </div>
        )}

        {step === 'done' && (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center space-y-4">
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto">
              <span className="text-green-600 text-xl">&#10003;</span>
            </div>
            <p className="font-medium text-slate-800">Schema analysis complete</p>
            <p className="text-sm text-slate-500">AI-generated definitions are ready for your review.</p>
            <button
              onClick={() => router.push(`/semantic?connectionId=${connId}`)}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              Review definitions
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
