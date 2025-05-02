// src/components/watchlist/WatchlistPage.tsx
import React, { useState, useEffect } from 'react';
import * as signalR from '@microsoft/signalr';
import { getAuth } from 'firebase/auth';
import LogoImage from '~/core/ui/Logo/LogoImage';
import { FaRegComment, FaBullhorn, FaTrash } from 'react-icons/fa';

interface WatchlistSymbol {
  id: number;
  symbol: string;
  percentChange: string;
  lastPrice: string;
}

interface Watchlist {
  name: string;
  symbols: WatchlistSymbol[];
}

interface Tweet {
  id: string;
  username: string;
  created_at: string;
  text: string;
  symbol?: string;
}

interface TradeExchangePost {
  id: string;
  source: string;
  content: string;
  save_time_utc: string;
}

export default function WatchlistPage() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedWatchlistIndex, setSelectedWatchlistIndex] = useState(0);
  const [newWatchlistName, setNewWatchlistName] = useState('');
  const [newSymbolText, setNewSymbolText] = useState('');
  const [connection, setConnection] = useState<signalR.HubConnection | null>(null);

  const [tweetsBySymbol, setTweetsBySymbol] = useState<Record<string, Tweet[]>>({});
  const [tweetFilter, setTweetFilter] = useState<string | null>('*');
  const [expandedTweets, setExpandedTweets] = useState<Set<string>>(new Set());

  const [tradePosts, setTradePosts] = useState<TradeExchangePost[]>([]);

  const srUrl = 'https://tradecompanion.azurewebsites.net/api';
  const current = watchlists[selectedWatchlistIndex] || { name: '', symbols: [] };

  // Soft gradient base for all buttons (normal + hover)
  const btnClasses = `
    bg-gradient-to-r from-blue-600/20 via-cyan-300/20 to-purple-600/20
    border border-gray-600
    rounded px-4 py-2
    transition transform
    hover:-translate-y-0.5 hover:scale-105
    hover:bg-gradient-to-r hover:from-blue-500/40 hover:via-cyan-400/40 hover:to-purple-500/40
    hover:text-white
    focus:outline-none focus:ring-2 focus:ring-blue-500/50
  `;

  // 1) Load watchlists from Firestore
  useEffect(() => {
    (async () => {
      const auth = getAuth(), user = auth.currentUser;
      if (!user) return;
      const res = await fetch('/api/watchlist/loadwatchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: user.uid }),
      });
      if (!res.ok) return;
      const { watchlists } = await res.json();
      setWatchlists(
        watchlists.length
          ? watchlists
          : [{ name: 'Watchlist 1', symbols: [] }]
      );
    })();
  }, []);

  // 2) SignalR live quotes + update local state
  useEffect(() => {
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(srUrl, {
        transport: signalR.HttpTransportType.WebSockets,
        withCredentials: false,
      })
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    conn.on('BroadcastQuotes', (data: any[]) => {
      setWatchlists(prev =>
        prev.map(wl => ({
          ...wl,
          symbols: wl.symbols.map(s => {
            const q = data.find(q => q.s === s.symbol);
            if (!q) return s;
            const last = q.l;
            const open = q.o != null ? q.o : parseFloat(s.lastPrice) || 0;
            return {
              ...s,
              lastPrice: last.toFixed(2),
              percentChange:
                open > 0
                  ? `${(((last - open) / open) * 100).toFixed(2)}%`
                  : s.percentChange,
            };
          }),
        }))
      );
    });

    conn.start().then(() => setConnection(conn)).catch(console.error);
    return () => void conn.stop();
  }, []);

  // 2b) Once connected, auto‑subscribe to all existing symbols
  useEffect(() => {
    if (!connection) return;
    current.symbols.forEach(s => {
      connection.invoke('Subscribe', s.symbol).catch(console.error);
      // or: fetch(`${srUrl}/SubL1?symbol=${s.symbol}&connectionId=${connection.connectionId}`);
    });
  }, [connection, current.symbols]);

  // helper to subscribe a new symbol
  const subscribe = async (sym: string) => {
    if (!connection?.connectionId) return;
    await fetch(`${srUrl}/SubL1?symbol=${sym}&connectionId=${connection.connectionId}`);
  };

  // 3) CRUD: add watchlist, add symbol, delete symbol, save to Firestore
  const addWatchlist = () => {
    const nm = newWatchlistName.trim();
    if (!nm) return;
    setWatchlists(prev => [...prev, { name: nm, symbols: [] }]);
    setSelectedWatchlistIndex(watchlists.length);
    setNewWatchlistName('');
  };

  const addSymbol = () => {
    const txt = newSymbolText.trim().toUpperCase();
    if (!txt) return;
    const id = current.symbols.length
      ? current.symbols[current.symbols.length - 1].id + 1
      : 1;
    const sym = { id, symbol: txt, percentChange: '+0.00%', lastPrice: '0.00' };
    setWatchlists(prev =>
      prev.map((w, i) =>
        i === selectedWatchlistIndex
          ? { ...w, symbols: [...w.symbols, sym] }
          : w
      )
    );
    setNewSymbolText('');
    subscribe(txt);
  };

  const deleteSymbol = (symbolId: number) => {
    setWatchlists(prev =>
      prev.map((w, i) =>
        i === selectedWatchlistIndex
          ? { ...w, symbols: w.symbols.filter(s => s.id !== symbolId) }
          : w
      )
    );
    setTweetFilter('*');
  };

  const saveToFirebase = async () => {
    const auth = getAuth(), user = auth.currentUser;
    if (!user) {
      alert('Please log in');
      return;
    }
    const res = await fetch('/api/watchlist/savewatchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: user.uid, watchlists }),
    });
    alert(res.ok ? '✅ Saved' : '❌ Save failed');
  };

  // 4) Fetch tweets for current watchlist symbols
  useEffect(() => {
    if (!current.symbols.length) {
      setTweetsBySymbol({});
      return;
    }
    (async () => {
      try {
        const res = await fetch(`${srUrl}/tweets?since=0&t=${Date.now()}`);
        if (!res.ok) throw new Error(await res.text());
        const all: Tweet[] = await res.json();
        const bySym: Record<string, Tweet[]> = {};
        current.symbols.forEach(s => {
          bySym[s.symbol] = all
            .filter(t => t.text.includes(`$${s.symbol}`))
            .slice(-6)
            .reverse();
        });
        setTweetsBySymbol(bySym);
        setTweetFilter('*');
        setExpandedTweets(new Set());
      } catch (e) {
        console.error('Error loading tweets', e);
        setTweetsBySymbol({});
      }
    })();
  }, [current.symbols]);

  // 5) Fetch & console.log TradeExchange posts
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${srUrl}/TradeExchangeGet`);
        if (!res.ok) throw new Error(await res.text());
        const data: TradeExchangePost[] = await res.json();
        console.log('🔍 TradeExchangeGet posts:', data);
        setTradePosts(data);
      } catch (e) {
        console.error('Error loading TradeExchangeGet posts', e);
      }
    })();
  }, []);

  // toggle tweet “show more”
  const toggleExpand = (id: string) => {
    setExpandedTweets(prev => {
      const nxt = new Set(prev);
      nxt.has(id) ? nxt.delete(id) : nxt.add(id);
      return nxt;
    });
  };

  // simple linkify for URLs in tweet text
  const linkify = (text: string) =>
    text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
      /^https?:\/\//.test(part) ? (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-300 underline"
        >
          {part}
        </a>
      ) : (
        part
      )
    );

  // Which tweets to show (all or per‑symbol)
  const displayedTweets: (Tweet & { symbol: string })[] =
    tweetFilter === '*'
      ? Object.entries(tweetsBySymbol)
          .flatMap(([sym, arr]) => arr.map(t => ({ ...t, symbol: sym })))
          .slice(0, 12)
      : (tweetsBySymbol[tweetFilter!] || []).map(t => ({
          ...t,
          symbol: tweetFilter!,
        }));

  // Which TradeExchange posts to show (filter out <5 chars)
  const displayedTrades = tradePosts
    .filter(p => p.content.length >= 5)
    .slice(-6)
    .reverse();

  return (
    <div className="bg-black text-gray-200 min-h-screen relative">
      {/* fixed-gradient backdrop */}
      <div
        className="absolute inset-0 bg-gradient-to-br from-gray-900 via-gray-800 to-black"
        style={{ backgroundAttachment: 'fixed' }}
      />

      <div className="relative z-10 max-w-7xl mx-auto p-6 space-y-8">
        {/* Logo */}
        <div className="flex justify-center">
          <LogoImage style={{ width: 200, height: 120 }} />
        </div>

        {/* Top Controls */}
        <div className="flex flex-wrap gap-4 items-center justify-center">
          <select
            value={selectedWatchlistIndex}
            onChange={e => {
              setSelectedWatchlistIndex(+e.target.value);
              setTweetFilter('*');
            }}
            className="px-3 py-2 bg-gray-800 border border-gray-600 rounded"
          >
            {watchlists.map((w, i) => (
              <option key={i} value={i}>
                {w.name}
              </option>
            ))}
          </select>

          <input
            className="px-3 py-2 bg-gray-800 border border-gray-600 rounded"
            placeholder="New Watchlist"
            value={newWatchlistName}
            onChange={e => setNewWatchlistName(e.target.value)}
          />
          <button onClick={addWatchlist} className={btnClasses}>
            Add Watchlist
          </button>

          <input
            className="px-3 py-2 bg-gray-800 border border-gray-600 rounded"
            placeholder="Add Symbol"
            value={newSymbolText}
            onChange={e => setNewSymbolText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addSymbol()}
          />
          <button onClick={addSymbol} className={btnClasses}>
            Add Symbol
          </button>

          <button
            onClick={() => setTweetFilter(prev => (prev === '*' ? null : '*'))}
            className={btnClasses}
          >
            {tweetFilter === '*' ? 'Hide All Tweets' : 'Show All Tweets'}
          </button>

          <button onClick={saveToFirebase} className={btnClasses}>
            💾 Save
          </button>
        </div>

        {/* Quotes Table */}
        <div className="bg-gray-900 rounded-lg shadow-xl p-4 overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-gray-800 text-gray-300">
              <tr>
                <th className="px-4 py-2 border border-gray-700">Symbol</th>
                <th className="px-4 py-2 border border-gray-700">% Change</th>
                <th className="px-4 py-2 border border-gray-700">Last Price</th>
                <th className="px-4 py-2 border border-gray-700">Tweets</th>
                <th className="px-4 py-2 border border-gray-700">Delete</th>
              </tr>
            </thead>
            <tbody>
              {current.symbols.map(s => (
                <tr
                  key={s.id}
                  className="hover:bg-gradient-to-r hover:from-blue-500 hover:via-cyan-500 hover:to-purple-500 hover:text-white transition transform"
                >
                  <td className="px-4 py-2 border border-gray-700">{s.symbol}</td>
                  <td className="px-4 py-2 border border-gray-700">
                    {s.percentChange}
                  </td>
                  <td className="px-4 py-2 border border-gray-700">
                    {s.lastPrice}
                  </td>
                  <td className="px-4 py-2 border border-gray-700 text-center">
                    <button
                      onClick={() =>
                        setTweetFilter(f =>
                          f === s.symbol ? '*' : s.symbol
                        )
                      }
                      className="text-blue-300 hover:text-white transition"
                    >
                      {tweetFilter === s.symbol ? 'Hide' : 'Show'}
                    </button>
                  </td>
                  <td className="px-4 py-2 border border-gray-700 text-center">
                    <button
                      onClick={() => deleteSymbol(s.id)}
                      className="text-red-400 hover:text-red-200 transition"
                    >
                      <FaTrash />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Tweets Section */}
        {tweetFilter !== null && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold flex items-center justify-center">
              <FaRegComment className="mr-2" />
              {tweetFilter === '*'
                ? 'All Recent Tweets'
                : `Tweets for ${tweetFilter}`}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {displayedTweets.length > 0 ? (
                displayedTweets.map(t => {
                  const isLong = t.text.length > 200;
                  const exp = expandedTweets.has(t.id);
                  return (
                    <a
                      key={t.id}
                      href={`https://twitter.com/${t.username}/status/${t.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="
                        bg-gray-700 bg-opacity-60 border border-gray-600
                        rounded-lg p-4 shadow-lg ring-1 ring-inset ring-gray-600
                        transition transform hover:-translate-y-1 hover:scale-105
                        hover:bg-gradient-to-r hover:from-blue-500/30 hover:via-cyan-400/30 hover:to-purple-500/30
                        hover:text-white flex flex-col
                      "
                      style={{ minHeight: '14rem' }}
                    >
                      <div className="text-blue-300 text-sm font-medium">
                        @{t.username}
                        <span className="text-xs text-gray-400 ml-2">
                          {new Date(t.created_at).toLocaleString()}
                        </span>
                      </div>
                      <p
                        className={`mt-2 text-gray-100 whitespace-pre-wrap flex-1 leading-relaxed ${
                          !exp && isLong ? 'max-h-24 overflow-hidden' : ''
                        }`}
                      >
                        {linkify(t.text)}
                      </p>
                      {isLong && (
                        <button
                          onClick={e => {
                            e.preventDefault();
                            toggleExpand(t.id);
                          }}
                          className="mt-2 text-blue-400 hover:text-blue-200 self-end text-sm"
                        >
                          {exp ? '⏶ Show Less' : '⏷ Show More'}
                        </button>
                      )}
                    </a>
                  );
                })
              ) : (
                <p className="col-span-full text-center text-gray-500">
                  No tweets found.
                </p>
              )}
            </div>
          </div>
        )}

        {/* TradeExchange Section */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold flex items-center justify-center">
            <FaBullhorn className="mr-2" /> Recent TradeExchange Posts
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {displayedTrades.length > 0 ? (
              displayedTrades.map(p => (
                <div
                  key={p.id}
                  className="
                    bg-gray-700 bg-opacity-60 border border-green-600
                    rounded-lg p-4 shadow-lg ring-1 ring-inset ring-green-600
                    transition transform hover:-translate-y-1 hover:scale-105
                    hover:bg-gradient-to-r hover:from-green-500/30 hover:via-lime-400/30 hover:to-green-300/30
                    hover:text-white flex flex-col
                  "
                  style={{ minHeight: '14rem' }}
                >
                  <div className="text-green-300 text-sm font-medium">
                    {new Date(p.save_time_utc).toLocaleString()}
                    <span className="text-xs text-gray-400 ml-2">{p.source}</span>
                  </div>
                  <p className="mt-2 text-gray-100 whitespace-pre-wrap flex-1 leading-relaxed">
                    {p.content}
                  </p>
                </div>
              ))
            ) : (
              <p className="col-span-full text-center text-gray-500">
                No TradeExchange posts.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
