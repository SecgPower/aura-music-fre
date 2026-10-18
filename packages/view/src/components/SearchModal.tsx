import GlassMaterial from "../glass/GlassMaterial";
import { GlassMenu } from "../glass/GlassDialog";
import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { SearchIcon, PlayIcon, PlusIcon } from "./Icons";
import SmartImage from "./SmartImage";
import { Song } from "@aura-music/core/types";
import {
  getNeteaseAudioUrl,
  NeteaseTrackInfo,
} from "@aura-music/player/services/lyricsService";
import { useI18n } from "../hooks/useI18n";
import { useKeyboardScope } from "@aura-music/core/react/useKeyboardScope";
import { useSearchModal } from "../hooks/useSearchModal";

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  queue: Song[];
  onPlayQueueIndex: (index: number) => void;
  onImportAndPlay: (song: Song) => void;
  onAddToQueue: (song: Song) => void;
  currentSong: Song | null;
  isPlaying: boolean;
  accentColor: string;
}

const SEQUOIA_SCROLLBAR_STYLES = `
  .sequoia-scrollbar {
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.0) transparent;
    transition: scrollbar-color 0.3s ease;
  }
  .sequoia-scrollbar:hover {
    scrollbar-color: rgba(255, 255, 255, 0.4) transparent;
  }
  .sequoia-scrollbar::-webkit-scrollbar {
    width: 14px;
  }
  .sequoia-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .sequoia-scrollbar::-webkit-scrollbar-thumb {
    background-color: rgba(255, 255, 255, 0.0);
    border: 5px solid transparent;
    background-clip: content-box;
    border-radius: 99px;
    transition: background-color 0.3s ease;
  }
  .sequoia-scrollbar:hover::-webkit-scrollbar-thumb {
    background-color: rgba(255, 255, 255, 0.4);
  }
  .sequoia-scrollbar::-webkit-scrollbar-thumb:hover {
    background-color: rgba(255, 255, 255, 0.6);
  }
`;

const ANIMATION_STYLES = `
  @keyframes modal-in {
      0% { opacity: 0; transform: scale(0.96) translateY(-8px); }
      100% { opacity: 1; transform: scale(1) translateY(0); }
  }
  @keyframes modal-out {
      0% { opacity: 1; transform: scale(1) translateY(0); }
      100% { opacity: 0; transform: scale(0.98) translateY(4px); }
  }
  @keyframes eq-bounce {
      0%, 100% { transform: scaleY(0.4); opacity: 0.8; }
      50% { transform: scaleY(1.0); opacity: 1; }
  }
  .macos-modal-in { animation: modal-in 0.2s cubic-bezier(0.2, 0.8, 0.2, 1) forwards; will-change: transform, opacity; }
  .macos-modal-out { animation: modal-out 0.15s cubic-bezier(0.32, 0.72, 0, 1) forwards; will-change: transform, opacity; }
`;

/* -------------------------------------------------------------------------- *
 * 网易云搜索原始报文 → NeteaseTrackInfo
 * 报文形如：{ "result": { "songs": [ { id, name, artists[], album{}, duration, ... } ] } }
 * -------------------------------------------------------------------------- */

interface NeteaseRawArtist {
  id?: number;
  name?: string;
  alias?: string[];
  picUrl?: string | null;
  img1v1Url?: string | null;
  img1v1?: number;
}

interface NeteaseRawAlbum {
  id?: number;
  name?: string;
  size?: number;
  picId?: number;
  picUrl?: string | null;
  blurPicUrl?: string | null;
  img1v1Url?: string | null;
  publishTime?: number;
  artist?: NeteaseRawArtist;
}

interface NeteaseRawSong {
  id?: number;
  name?: string;
  alias?: string[];
  transNames?: string[];
  duration?: number;
  fee?: number;
  mvid?: number;
  copyrightId?: number;
  artists?: NeteaseRawArtist[];
  album?: NeteaseRawAlbum;
}

interface NeteaseRawSearchResponse {
  code?: number;
  result?: { songs?: NeteaseRawSong[]; songCount?: number } | null;
  songs?: NeteaseRawSong[];
}

/** 归一化后的条目：保留 duration / fee 等原始字段，方便列表里直接展示 */
type NeteaseTrack = NeteaseTrackInfo & {
  duration?: number;
  fee?: number;
  alias?: string[];
  publishTime?: number;
};

/** 自建/托管的网易云 API 基址，用于按歌曲 id 补封面 */
const NETEASE_API_BASE = "https://netease-api.yearnplayground.dpdns.org";
/** 网易云的灰色默认头像，出现即视为“没有封面” */
const NETEASE_PLACEHOLDER_PIC = "5639395138885805";
/** 每批最多请求多少个 id，避免 URL 过长 */
const DETAIL_BATCH_SIZE = 20;

const toHttps = (url?: string | null): string =>
  url ? url.replace(/^http:\/\//, "https://").replace(/^http:/, "https:") : "";

/** 网易云图床支持 ?param=WyH 裁剪，原图动辄 3000px，列表里必须缩一下 */
const withSize = (url: string, size: number): string => {
  if (!url) return "";
  return url.includes("?") ? url : `${url}?param=${size}y${size}`;
};

/** 空串 / 默认灰头都算没有封面，需要走 /song/detail 补一次 */
const isUsableCover = (url?: string | null): boolean =>
  !!url && !url.includes(NETEASE_PLACEHOLDER_PIC);

const formatDuration = (ms?: number): string => {
  if (!ms || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * 封面 URL：album.picId 无法直接拼出 CDN 地址，所以优先取报文自带的
 * picUrl / blurPicUrl，都没有时退回歌手头像，再没有就留空（列表显示音符占位）。
 * 如果你的搜索接口不返回 picUrl，可以用 /api/song/detail?ids=[id] 补一次，
 * 或直接让后端把 picUrl 带出来。
 */
const resolveCoverUrl = (song: NeteaseRawSong): string => {
  const album = song.album;
  const artist = song.artists?.[0] ?? album?.artist;
  const raw =
    toHttps(album?.picUrl) ||
    toHttps(album?.blurPicUrl) ||
    toHttps(album?.img1v1Url) ||
    toHttps(artist?.picUrl) ||
    toHttps(artist?.img1v1Url) ||
    "";
  // 灰色默认头像等价于没图，直接丢弃，交给 /song/detail 补
  return isUsableCover(raw) ? raw : "";
};

const mapRawSong = (song: NeteaseRawSong): NeteaseTrack => {
  const id = Number(song.id);
  const names = (song.artists ?? [])
    .map((a) => a.name?.trim())
    .filter((n): n is string => !!n);
  return {
    id: String(id),
    neteaseId: id,
    title: song.name?.trim() || "",
    artist: names.length
      ? names.join(" / ")
      : (song.album?.artist?.name?.trim() ?? ""),
    album: song.album?.name?.trim() ?? "",
    coverUrl: resolveCoverUrl(song),
    duration: song.duration,
    fee: song.fee,
    alias: song.alias ?? song.transNames ?? [],
    publishTime: song.album?.publishTime,
  };
};

const isRawSong = (item: unknown): item is NeteaseRawSong => {
  if (!item || typeof item !== "object") return false;
  const v = item as Record<string, unknown>;
  return !("title" in v) && ("name" in v || "artists" in v || "album" in v);
};

/**
 * 兼容三种输入：
 *   - { result: { songs: [...] } }  —— /api/search/get/web 原始报文
 *   - { songs: [...] }              —— 去掉 result 外壳的情况
 *   - NeteaseTrackInfo[]            —— 已归一化过的旧数据，原样返回
 */
const parseNeteaseSearch = (input: unknown): NeteaseTrack[] => {
  if (!input) return [];
  let list: unknown[] | undefined;
  if (Array.isArray(input)) {
    list = input;
  } else {
    const obj = input as NeteaseRawSearchResponse;
    if (Array.isArray(obj.result?.songs)) list = obj.result!.songs;
    else if (Array.isArray(obj.songs)) list = obj.songs;
  }
  if (!list) return [];
  return list.reduce<NeteaseTrack[]>((acc, item) => {
    if (!item || typeof item !== "object") return acc;
    if (isRawSong(item)) {
      const track = mapRawSong(item);
      // 丢掉没有有效 id 的脏数据（如 id 为 null 的条目）
      if (toTrackId(track) > 0) acc.push(track);
    } else {
      // 已归一化过的旧数据：补齐 coverUrl，并把 id 强制归一成 number/string
      const known = item as NeteaseTrack;
      const numericId = Number(known.neteaseId ?? known.id);
      acc.push({
        ...known,
        id: String(known.id ?? known.neteaseId ?? ""),
        neteaseId: numericId,
        coverUrl: isUsableCover(known.coverUrl) ? toHttps(known.coverUrl) : "",
      });
    }
    return acc;
  }, []);
};

/**
 * id 归一：透传分支里 neteaseId 可能是字符串（如 '521416693'），
 * 直接用会让 Number.isFinite 判 false 而被整批过滤掉，所以统一转 number。
 */
const toTrackId = (t: NeteaseTrack): number => {
  const n = Number(t.neteaseId ?? t.id);
  return Number.isFinite(n) ? n : 0;
};

/** detailMap / requestedIds 的统一 key，一律用字符串 */
const trackKey = (t: NeteaseTrack): string => String(t.id ?? t.neteaseId ?? "");

/**
 * 是否需要回查详情：封面、歌手、专辑三者缺一就需要。
 * 搜索报文的 album.name 常是空串（只有 picId），专辑名必须靠 /song/detail 补。
 */
const needsDetail = (
  t: NeteaseTrack,
  detailMap: Record<string, NeteaseTrackPatch>,
): boolean => {
  const patch = detailMap[trackKey(t)] ?? {};
  const hasCover = isUsableCover(patch.coverUrl) || isUsableCover(t.coverUrl);
  const hasArtist = !!(patch.artist || t.artist);
  const hasAlbum = !!(patch.album || t.album);
  return !hasCover || !hasArtist || !hasAlbum;
};

/** 单条调试摘要：id + 歌名 + 三个字段各自的来源情况 */
const describeTrack = (t: NeteaseTrack): string =>
  `${toTrackId(t)} ${t.title} → cover=${t.coverUrl || "（无）"} | artist=${t.artist || "（无）"} | album=${t.album || "（无）"}`;

/* -------------------------------------------------------------------------- *
 * 元数据补全：搜索报文里只有 album.picId（拼不出图床直链），且 album.name 常为空，
 * 所以按 id 回查一次详情，补齐 封面 / 歌手 / 专辑
 * GET {NETEASE_API_BASE}/song/detail?ids=id1,id2,...
 *   → songs[].al.picUrl（封面）、songs[].al.name（专辑）、songs[].ar[].name（歌手）
 * 注意：该接口的 ids 是逗号分隔的裸数字，不是 JSON 数组 / 中括号包裹
 * -------------------------------------------------------------------------- */

interface NeteaseSongDetail {
  id?: number;
  al?: { id?: number; name?: string | null; picUrl?: string | null; pic_str?: string; pic?: number } | null;
  ar?: { id?: number; name?: string | null }[] | null;
}

/** 一次详情回查能补出来的字段，全部可选——只覆盖搜索报文里缺的那部分 */
interface NeteaseTrackPatch {
  coverUrl?: string;
  artist?: string;
  album?: string;
}

/** 调试开关：关掉后所有补全相关日志静默 */
const NETEASE_COVER_DEBUG = true;

const coverLog = (...args: unknown[]): void => {
  if (NETEASE_COVER_DEBUG) console.log("[NeteaseCover]", ...args);
};

/** 拉一批歌曲详情，返回 { 歌曲id: 补丁 }；失败时返回空对象，不影响列表渲染 */
const fetchSongDetails = async (
  ids: number[],
): Promise<Record<string, NeteaseTrackPatch>> => {
  if (!ids.length) {
    coverLog("skip: 没有需要回查的 id");
    return {};
  }
  const query = ids.join(",");
  const url = `${NETEASE_API_BASE}/song/detail?ids=${query}`;
  coverLog(`fetchSongDetails 收到 ${ids.length} 个 id:`, ids);
  coverLog("拼接 URL:", url);
  try {
    const res = await fetch(url);
    coverLog("响应状态:", res.status, res.ok ? "OK" : "非 2xx，放弃本批");
    if (!res.ok) return {};
    const json = (await res.json()) as { songs?: NeteaseSongDetail[] | null };
    const patches: Record<string, NeteaseTrackPatch> = {};
    for (const song of json.songs ?? []) {
      if (!song?.id) continue;
      const key = String(song.id);
      const patch: NeteaseTrackPatch = {};

      const pic = toHttps(song.al?.picUrl ?? "");
      if (isUsableCover(pic)) patch.coverUrl = pic;

      // 专辑名：搜索报文的 album.name 经常是空串，这里才是准的
      const albumName = song.al?.name?.trim();
      if (albumName) patch.album = albumName;

      // 歌手：多歌手用 " / " 拼，和搜索报文保持一致的展示格式
      const names = (song.ar ?? [])
        .map((a) => a?.name?.trim())
        .filter((n): n is string => !!n);
      if (names.length) patch.artist = names.join(" / ");

      if (Object.keys(patch).length) patches[key] = patch;
    }
    coverLog(
      `解析完成：接口返回 ${json.songs?.length ?? 0} 首，可用补丁 ${Object.keys(patches).length} 条`,
      patches,
    );
    const missing = ids.filter((id) => !patches[String(id)]);
    if (missing.length) coverLog("以下 id 没拿到任何详情:", missing);
    return patches;
  } catch (err) {
    coverLog("请求失败:", err);
    return {};
  }
};

const SearchModal: React.FC<SearchModalProps> = ({
  isOpen,
  onClose,
  queue,
  onPlayQueueIndex,
  onImportAndPlay,
  onAddToQueue,
  currentSong,
  isPlaying,
  accentColor,
}) => {
  const { dict } = useI18n();

  // Animation State
  const [isRendering, setIsRendering] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  // Refs
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const located = useRef(false);

  // Use search modal hook
  const search = useSearchModal({
    queue,
    currentSong,
    isPlaying,
    isOpen,
  });

  // 云端搜索结果归一化：把 { result: { songs: [...] } } 原始报文转成 NeteaseTrackInfo
  const neteaseTracks = useMemo(
    () => parseNeteaseSearch(search.neteaseProvider.results),
    [search.neteaseProvider.results],
  );

  // 回查到的元数据缓存 { 歌曲id: {封面/歌手/专辑} }，跨搜索复用
  const [detailMap, setDetailMap] = useState<Record<string, NeteaseTrackPatch>>({});
  // 已经请求过的 id，无论成败都不再重复请求（避免失败时无限重试）
  const requestedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    coverLog(
      `搜索结果 ${neteaseTracks.length} 首，已缓存详情 ${Object.keys(detailMap).length} 条，已请求过 ${requestedIds.current.size} 个 id`,
    );
    coverLog(
      "本轮结果 id 列表:",
      neteaseTracks.map(toTrackId),
      "(类型: " + (neteaseTracks[0] ? typeof neteaseTracks[0].neteaseId : "-") + ")",
    );
    coverLog("逐条字段情况:\n" + neteaseTracks.map(describeTrack).join("\n"));
    const missing = neteaseTracks
      .filter((t) => needsDetail(t, detailMap) && !requestedIds.current.has(trackKey(t)))
      .map(toTrackId)
      .filter((id) => Number.isFinite(id) && id > 0);
    coverLog(
      "需要回查详情的 id:",
      missing.length ? missing : "（无，封面/歌手/专辑均已齐）",
    );
    if (!missing.length) return;

    missing.forEach((id) => requestedIds.current.add(String(id)));
    let alive = true;

    // 分批并发，避免单次 URL 过长
    const batches: number[][] = [];
    for (let i = 0; i < missing.length; i += DETAIL_BATCH_SIZE) {
      batches.push(missing.slice(i, i + DETAIL_BATCH_SIZE));
    }
    if (batches.length > 1) coverLog(`分成 ${batches.length} 批并发请求`);
    Promise.all(batches.map(fetchSongDetails))
      .then((results) => {
        if (!alive) {
          coverLog("组件已卸载/切换，丢弃本轮结果");
          return;
        }
        const merged = results.reduce<Record<string, NeteaseTrackPatch>>(
          (acc, m) => Object.assign(acc, m),
          {},
        );
        coverLog("合并后新增详情:", Object.keys(merged).length, "条", merged);
        if (Object.keys(merged).length) setDetailMap((prev) => ({ ...prev, ...merged }));
      })
      .catch((err) => coverLog("批次请求异常:", err));

    return () => {
      alive = false;
    };
  }, [neteaseTracks, detailMap]);

  /**
   * 列表与播放器统一从这里取最终展示值：
   * 回查结果优先，缺失部分再退回搜索报文自带。
   */
  const resolveTrackMeta = useMemo(
    () =>
      (
        track: NeteaseTrack,
      ): { cover: string; coverRaw: string; artist: string; album: string } => {
        const patch = detailMap[trackKey(track)] ?? {};
        const coverRaw = isUsableCover(patch.coverUrl)
          ? patch.coverUrl!
          : track.coverUrl || "";
        return {
          coverRaw,
          cover: withSize(coverRaw, 100),
          artist: patch.artist || track.artist || "",
          album: patch.album || track.album || "",
        };
      },
    [detailMap],
  );

  /** 播放器要高清封面，单独给一个带尺寸的版本 */
  const resolveLargeCover = useMemo(
    () =>
      (track: NeteaseTrack, size = 500): string =>
        withSize(resolveTrackMeta(track).coverRaw, size),
    [resolveTrackMeta],
  );

  useLayoutEffect(() => {
    if (!isOpen || search.activeTab !== "queue" || search.query.trim()) {
      located.current = false;
      return;
    }
    if (!isRendering || located.current || !listRef.current) return;
    const index = search.queueResults.findIndex((item) => item.s.id === currentSong?.id);
    const row = search.itemRefs.current[index];
    if (!row) return;
    // Position after the portal mounts, once per opening. Manual scrolling and
    // keyboard navigation stay in the user's control while the panel is open.
    listRef.current.scrollTo({
      top: row.offsetTop + 12 - (listRef.current.clientHeight - row.offsetHeight) / 2,
      behavior: "instant",
    });
    search.setSelectedIndex(index);
    located.current = true;
  }, [isOpen, isRendering, search.activeTab, search.query, search.queueResults, currentSong?.id]);

  // --- Animation Handling ---
  useEffect(() => {
    if (isOpen) {
      setIsRendering(true);
      setIsClosing(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    } else if (isRendering && !isClosing) {
      setIsClosing(true);
      const timer = setTimeout(() => {
        setIsRendering(false);
        setIsClosing(false);
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [isOpen, isRendering]);

  // --- Close context menu on outside click ---
  useEffect(() => {
    if (!search.contextMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".context-menu-container")) {
        search.closeContextMenu();
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [search.contextMenu]);

  // --- Keyboard Scope (High Priority: 100) ---
  useKeyboardScope(
    (e) => {
      if (!isOpen) return false;

      if (search.contextMenu) {
        if (e.key === "Escape") { e.preventDefault(); search.closeContextMenu(); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const nodes = Array.from(document.querySelectorAll<HTMLElement>(".context-menu-container [role='menuitem']"));
          const index = nodes.indexOf(document.activeElement as HTMLElement);
          nodes[e.key === "Home" ? 0 : e.key === "End" ? nodes.length - 1 : (index + (e.key === "ArrowUp" ? -1 : 1) + nodes.length) % nodes.length]?.focus();
        }
        return true;
      }

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          search.navigateDown();
          return true;
        }
        case "ArrowUp": {
          e.preventDefault();
          search.navigateUp();
          return true;
        }
        case "Enter": {
          e.preventDefault();
          if (search.selectedIndex >= 0) {
            handleSelection(search.selectedIndex);
          } else if (search.activeTab === "netease" && search.query.trim()) {
            search.performNeteaseSearch();
          }
          return true;
        }
        case "Escape": {
          e.preventDefault();
          onClose();
          return true;
        }
        case "Tab": {
          e.preventDefault();
          search.switchTab();
          return true;
        }
      }
      return false;
    },
    100,
    isOpen,
  );

  // --- Actions ---

  const handleSelection = (index: number) => {
    if (search.activeTab === "queue") {
      const item = search.queueResults[index];
      if (item) {
        onPlayQueueIndex(item.i);
        onClose();
      }
    } else {
      const track = neteaseTracks[index];
      if (track) {
        playNeteaseTrack(track);
        onClose();
      }
    }
  };

  const playNeteaseTrack = (track: NeteaseTrack) => {
    const origin = getNeteaseAudioUrl(track.id);
    const meta = resolveTrackMeta(track);
    const song: Song = {
      id: track.id,
      title: track.title,
      artist: meta.artist,
      coverUrl: resolveLargeCover(track),
      fileUrl: origin,
      source: "remote",
      origin,
      isNetease: true,
      neteaseId: track.neteaseId,
      album: meta.album,
      lyrics: [],
      needsLyricsMatch: true,
    };
    onImportAndPlay(song);
  };

  const addNeteaseToQueue = (track: NeteaseTrack) => {
    const origin = getNeteaseAudioUrl(track.id);
    const meta = resolveTrackMeta(track);
    const song: Song = {
      id: track.id,
      title: track.title,
      artist: meta.artist,
      coverUrl: resolveLargeCover(track),
      fileUrl: origin,
      source: "remote",
      origin,
      isNetease: true,
      neteaseId: track.neteaseId,
      album: meta.album,
      lyrics: [],
      needsLyricsMatch: true,
    };
    onAddToQueue(song);
  };

  // Reset refs


  if (!isRendering) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center px-4 select-none font-sans"
      onMouseDown={(e) => {
        const target = e.target as HTMLElement;
        if (!modalRef.current?.contains(target)) {
          onClose();
        }
        if (!target.closest(".context-menu-container")) {
          search.closeContextMenu();
        }
      }}
    >
      <style>{SEQUOIA_SCROLLBAR_STYLES}</style>
      <style>{ANIMATION_STYLES}</style>

      {/* Backdrop - Animated */}
      <div
        className={`absolute inset-0 bg-black/20 backdrop-blur-xs transition-opacity duration-300 ${isClosing ? "opacity-0" : "opacity-100"}`}
        aria-hidden="true"
      />

      {/* Modal Container - Sequoia Style */}
      <div
        className={`
        relative glass-surface w-full max-w-[720px] h-[600px] max-h-[85dvh] rounded-[28px]
        flex flex-col overflow-hidden
        ${isClosing ? "macos-modal-out" : "macos-modal-in"}
        text-white
      `}
        ref={modalRef}
        role="dialog" aria-modal="true" aria-label={dict.top.search}
      >
        <GlassMaterial />
        {/* Header Area */}
        <div className="flex flex-col px-5 pt-5 pb-3 gap-4 border-b border-white/10 shrink-0 bg-white/5 z-10">
          {/* macOS-style segmented control: a recessed track with a single
              raised, sliding segment (top highlight + soft shadow). */}
          <div className="relative isolate flex items-center self-center w-full max-w-xs mb-1 p-[2px] rounded-[9px] bg-black/25 shadow-[inset_0_0.5px_1px_rgba(0,0,0,0.3),0_0_0_0.5px_rgba(255,255,255,0.06)]">
            {/* Raised selected segment */}
            <div
              className="absolute top-[2px] bottom-[2px] rounded-[7px] bg-white/[0.16] shadow-[0_1px_1px_rgba(0,0,0,0.2),0_2px_4px_rgba(0,0,0,0.14),inset_0_0.5px_0_rgba(255,255,255,0.3)] transition-[left] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
              style={{
                left: search.activeTab === "queue" ? "2px" : "50%",
                width: "calc(50% - 2px)",
              }}
            />

            <button
              onClick={() => {
                search.setActiveTab("queue");
              }}
              className={`
                        relative flex-1 py-[5px] text-[13px] font-medium leading-none transition-colors duration-200 z-10
                        ${search.activeTab === "queue" ? "text-white" : "text-white/55 hover:text-white/75"}
                    `}
            >
              {search.queueProvider.label}
            </button>
            <button
              onClick={() => {
                search.setActiveTab("netease");
              }}
              className={`
                        relative flex-1 py-[5px] text-[13px] font-medium leading-none transition-colors duration-200 z-10
                        ${search.activeTab === "netease" ? "text-white" : "text-white/55 hover:text-white/75"}
                    `}
            >
              {search.neteaseProvider.label}
            </button>
          </div>

          {/* Search Bar */}
          <div className="relative group mx-2">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
              <SearchIcon className="w-5 h-5 text-white/40" />
            </div>
            <input
              ref={inputRef}
              type="text"
              value={search.query}
              onChange={(e) => search.setQuery(e.target.value)}
              placeholder={
                search.activeTab === "netease"
                  ? dict.search.online
                  : dict.search.queue
              }
              className="
                        w-full pl-12 pr-4 py-3
                        bg-black/20 hover:bg-black/25 focus:bg-black/30
                        border border-white/10 focus:border-white/15
                        rounded-[10px]
                        text-lg font-medium text-white placeholder:text-white/35
                        outline-hidden
                        shadow-[inset_0_1px_2px_rgba(0,0,0,0.28)]
                        focus:shadow-[inset_0_1px_2px_rgba(0,0,0,0.28),0_0_0_3.5px_rgba(10,132,255,0.35)]
                        transition-all duration-200
                    "
            />
          </div>
        </div>

        {/* Results Area */}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto sequoia-scrollbar p-3 scroll-smooth"
          onScroll={search.handleScroll}
        >
          {/* Queue Results */}
          {search.activeTab === "queue" && (
            <div className="relative flex flex-col gap-1">
              {search.queueResults.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 text-white/20">
                  <span className="text-lg">{dict.search.emptyQueue}</span>
                </div>
              ) : (
                <>
                  {/* Floating Selection Background */}
                  {search.selectedIndex >= 0 && search.itemRefs.current[search.selectedIndex] && (
                    <div
                      className="absolute left-0 right-0 bg-white/10 rounded-[10px] pointer-events-none transition-all duration-200 ease-out"
                      style={{
                        top: `${search.itemRefs.current[search.selectedIndex]?.offsetTop || 0}px`,
                        height: `${search.itemRefs.current[search.selectedIndex]?.offsetHeight || 56}px`,
                        zIndex: 0,
                      }}
                    />
                  )}

                  {search.queueResults.map(({ s, i }, idx) => {
                    const nowPlaying = search.isNowPlaying(s);
                    return (
                      <div
                        key={`${s.id}-${i}`}
                        aria-current={nowPlaying ? "true" : undefined}
                        ref={(el) => {
                          search.itemRefs.current[idx] = el;
                        }}
                        onClick={() => handleSelection(idx)}
                        onContextMenu={(e) =>
                          search.openContextMenu(e, s, "queue")
                        }
                        className={`
                                        relative z-10 group flex items-center gap-3 p-3 rounded-[10px] cursor-pointer
                                        ${search.selectedIndex === idx ? "text-white" : "hover:bg-white/5 hover:transition-colors hover:duration-150 text-white/90"}
                                    `}
                      >
                        <div className="relative w-10 h-10 rounded-[6px] bg-white/5 overflow-hidden shrink-0 shadow-xs group-hover:shadow-lg transition-shadow duration-200">
                          {s.coverUrl ? (
                            <SmartImage
                              src={s.coverUrl}
                              alt={s.title}
                              containerClassName="w-full h-full"
                              imgClassName={`w-full h-full object-cover transition-opacity ${nowPlaying ? "opacity-40 blur-[1px]" : ""}`}
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-xs opacity-30">
                              ♪
                            </div>
                          )}

                          {/* Play Button on Hover or Selected */}
                          {!nowPlaying && (
                            <div className={`absolute inset-0 flex items-center justify-center bg-black/50 ${search.selectedIndex === idx ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-hover:transition-opacity group-hover:duration-150"}`}>
                              <PlayIcon className="w-4 h-4 fill-white drop-shadow-md" />
                            </div>
                          )}

                          {/* Now Playing Indicator */}
                          {nowPlaying && isPlaying && (
                            <div className="absolute inset-0 flex items-center justify-center gap-[2px]">
                              <div
                                className="w-[2px] bg-current rounded-full animate-[eq-bounce_1s_ease-in-out_infinite]"
                                style={{ height: "8px", color: accentColor }}
                              ></div>
                              <div
                                className="w-[2px] bg-current rounded-full animate-[eq-bounce_1s_ease-in-out_infinite_0.2s]"
                                style={{ height: "14px", color: accentColor }}
                              ></div>
                              <div
                                className="w-[2px] bg-current rounded-full animate-[eq-bounce_1s_ease-in-out_infinite_0.4s]"
                                style={{ height: "10px", color: accentColor }}
                              ></div>
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
                          <div
                            className={`text-[15px] font-medium truncate ${search.selectedIndex === idx ? "text-white" : nowPlaying ? "" : "text-white/90"}`}
                            style={nowPlaying ? { color: accentColor } : {}}
                          >
                            {s.title}
                          </div>
                          <div
                            className={`text-[13px] truncate ${search.selectedIndex === idx ? "text-white/70" : "text-white/40"}`}
                          >
                            {s.artist}
                          </div>
                        </div>
                        {search.selectedIndex === idx && (
                          <div className="mr-1">
                            <PlayIcon className="w-5 h-5 fill-white/80" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* Netease Results */}
          {search.activeTab === "netease" && (
            <div className="relative flex flex-col gap-1 pb-4">
              {/* Prompt to press Enter */}
              {search.showNeteasePrompt && (
                <div className="flex flex-col items-center justify-center h-64 text-white/30">
                  <SearchIcon className="w-12 h-12 mb-4 opacity-20" />
                  <span className="text-base font-medium">
                    {dict.search.press}{" "}
                    <kbd className="px-2 py-1 bg-white/10 rounded text-white/60">
                      Enter
                    </kbd>{" "}
                    {dict.search.toSearch}
                  </span>
                </div>
              )}

              {/* No results after search */}
              {search.showNeteaseEmpty && (
                <div className="flex flex-col items-center justify-center h-64 text-white/20">
                  <SearchIcon className="w-12 h-12 mb-4 opacity-20" />
                  <span className="text-base font-medium">
                    {dict.search.noMatches}
                  </span>
                </div>
              )}

              {/* Loading State */}
              {search.showNeteaseLoading && (
                <div className="flex flex-col items-center justify-center h-64 text-white/20">
                  <div className="w-8 h-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin mb-4"></div>
                  <span className="text-base font-medium">{dict.search.loading}</span>
                </div>
              )}

              {/* Initial empty state */}
              {search.showNeteaseInitial && (
                <div className="flex flex-col items-center justify-center h-64 text-white/20">
                  <SearchIcon className="w-12 h-12 mb-4 opacity-20" />
                  <span className="text-base font-medium">
                    {dict.search.searchCloud}
                  </span>
                </div>
              )}

              {/* Results list */}
              {neteaseTracks.length > 0 && (
                <>
                  {/* Floating Selection Background */}
                  {search.selectedIndex >= 0 && search.itemRefs.current[search.selectedIndex] && (
                    <div
                      className="absolute left-0 right-0 bg-white/25 backdrop-blur-md rounded-[10px] pointer-events-none transition-all duration-200 ease-out"
                      style={{
                        top: `${search.itemRefs.current[search.selectedIndex]?.offsetTop || 0}px`,
                        height: `${search.itemRefs.current[search.selectedIndex]?.offsetHeight || 56}px`,
                        zIndex: 0,
                      }}
                    />
                  )}

                  {neteaseTracks.map((track, idx) => {
                    const nowPlaying = search.isNowPlaying(track);
                    const meta = resolveTrackMeta(track);
                    const displayCover = meta.cover;
                    // 副标题：歌手 / 专辑可能缺一个，只在两者都有时才显示分隔符
                    const subtitle = [meta.artist, meta.album]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <div
                        key={`${track.id}-${idx}`}
                        ref={(el) => {
                          search.itemRefs.current[idx] = el;
                        }}
                        onClick={() => handleSelection(idx)}
                        onContextMenu={(e) =>
                          search.openContextMenu(e, track, "netease")
                        }
                        className={`
                                        relative z-10 group flex items-center gap-3 p-3 rounded-[10px] cursor-pointer
                                        ${search.selectedIndex === idx ? "text-white" : "hover:bg-white/5 hover:transition-colors hover:duration-150 text-white/90"}
                                    `}
                      >
                        <div className="relative w-10 h-10 rounded-[6px] bg-white/5 overflow-hidden shrink-0 shadow-xs group-hover:shadow-lg transition-shadow duration-200">
                          {displayCover && (
                            <SmartImage
                              src={displayCover}
                              alt={track.title}
                              containerClassName="w-full h-full"
                              imgClassName={`w-full h-full object-cover transition-opacity ${nowPlaying ? "opacity-40 blur-[1px]" : ""}`}
                            />
                          )}

                          {/* Play Button on Hover or Selected */}
                          {!nowPlaying && (
                            <div className={`absolute inset-0 flex items-center justify-center bg-black/50 ${search.selectedIndex === idx ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-hover:transition-opacity group-hover:duration-150"}`}>
                              <PlayIcon className="w-4 h-4 fill-white drop-shadow-md" />
                            </div>
                          )}

                          {/* Now Playing Indicator */}
                          {nowPlaying && isPlaying && (
                            <div className="absolute inset-0 flex items-center justify-center gap-[2px]">
                              <div
                                className="w-[2px] bg-current rounded-full animate-[eq-bounce_1s_ease-in-out_infinite]"
                                style={{ height: "8px", color: accentColor }}
                              ></div>
                              <div
                                className="w-[2px] bg-current rounded-full animate-[eq-bounce_1s_ease-in-out_infinite_0.2s]"
                                style={{ height: "14px", color: accentColor }}
                              ></div>
                              <div
                                className="w-[2px] bg-current rounded-full animate-[eq-bounce_1s_ease-in-out_infinite_0.4s]"
                                style={{ height: "10px", color: accentColor }}
                              ></div>
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
                          <div
                            className={`text-[15px] font-medium truncate ${search.selectedIndex === idx ? "text-white" : nowPlaying ? "" : "text-white/90"}`}
                            style={nowPlaying ? { color: accentColor } : {}}
                          >
                            {track.title}
                          </div>
                          <div
                            className={`text-[13px] truncate ${search.selectedIndex === idx ? "text-white/70" : "text-white/40"}`}
                          >
                            {subtitle || "—"}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 px-2 shrink-0">
                          {formatDuration(track.duration) && (
                            <span className="text-[11px] tabular-nums text-white/30">
                              {formatDuration(track.duration)}
                            </span>
                          )}
                          <span
                            className={`
                                            text-[10px] font-bold px-1.5 py-0.5 rounded border
                                            ${search.selectedIndex === idx
                                ? "border-white/30 text-white/80 bg-white/20"
                                : "border-white/10 text-white/30 bg-white/5"
                              }
                                        `}
                          >
                            {dict.search.cloud}
                          </span>
                        </div>
                      </div>
                    );
                  })}

                  {/* Loading Indicator */}
                  {search.neteaseProvider.hasMore && (
                    <div className="py-6 flex items-center justify-center">
                      {search.neteaseProvider.isLoading ? (
                        <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin"></div>
                      ) : (
                        <div className="text-white/20 text-xs">
                          {dict.search.more}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Context Menu Portal */}
        {search.contextMenu &&
          createPortal(
            <GlassMenu open
              role="menu" aria-label={dict.controls.settings}
              className="context-menu-container fixed z-[10000] w-52 p-1.5"
              style={{ top: Math.min(search.contextMenu.y, window.innerHeight - 120), left: Math.min(search.contextMenu.x, window.innerWidth - 220) }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (search.contextMenu!.type === "queue") {
                    const qItem = search.contextMenu!.track as Song;
                    const idx = queue.findIndex((s) => s.id === qItem.id);
                    onPlayQueueIndex(idx);
                  } else {
                    playNeteaseTrack(
                      search.contextMenu!.track as NeteaseTrackInfo,
                    );
                  }
                  search.closeContextMenu();
                  onClose();
                }}
                role="menuitem" className="glass-menu-row"
              >
                <PlayIcon className="w-4 h-4" />
                {dict.search.playNow}
              </button>

              {search.contextMenu.type === "netease" && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    addNeteaseToQueue(
                      search.contextMenu!.track as NeteaseTrackInfo,
                    );
                    search.closeContextMenu();
                  }}
                  role="menuitem" className="glass-menu-row"
                >
                  <PlusIcon className="w-4 h-4" />
                  {dict.search.addToQueue}
                </button>
              )}
            </GlassMenu>,
            document.body,
          )}
      </div>
    </div>,
    document.body,
  );
};

export default SearchModal;
