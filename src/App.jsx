import { useEffect, useRef, useState, useCallback } from "react";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const DEFAULT_LAT = 23.998158;
const DEFAULT_LNG = 32.858493;

// ── SunCalc loader ─────────────────────────────────────────────────────────
let SunCalc = null;
async function loadSunCalc() {
  if (SunCalc) return SunCalc;
  const mod = await import("https://esm.sh/suncalc@1.9.0");
  SunCalc = mod.default || mod;
  return SunCalc;
}

// ── Date helpers ───────────────────────────────────────────────────────────
function dayOfYearToDate(year, doy) {
  const d = new Date(year, 0, 1);
  d.setDate(doy);
  return d;
}

function buildDateTime(doy, hour) {
  const now = new Date();
  const base = dayOfYearToDate(now.getFullYear(), doy);
  base.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
  return base;
}

function formatDayOfYear(doy) {
  const d = dayOfYearToDate(new Date().getFullYear(), doy);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatSeasonLabel(doy) {
  if (doy < 80) return { label: "Winter", icon: "❄️" };
  if (doy < 172) return { label: "Spring", icon: "🌸" };
  if (doy < 172) return { label: "Spring Equinox", icon: "🌱" };
  if (doy === 172) return { label: "Summer Solstice", icon: "🌞" };
  if (doy < 266) return { label: "Summer", icon: "🏖️" };
  if (doy < 355) return { label: "Autumn", icon: "🍂" };
  return { label: "Winter", icon: "❄️" };
}

// ── Sun position conversion ────────────────────────────────────────────────
// SunCalc returns { azimuth, altitude } both in radians
// SunCalc azimuth: 0 = South, +East, -West (clockwise from South)
// Mapbox azimuth:  0 = North, clockwise
// → mapboxAz = (suncalcAz * 180/π + 180) % 360
// Mapbox polar:    0 = zenith (straight down), 90 = horizon
// → mapboxPolar = 90 - altitudeDeg   (clamp 1–89 to avoid degenerate cases)
function sunCalcToMapbox(position) {
  const azDeg = (position.azimuth * 180 / Math.PI + 180) % 360;
  const altDeg = position.altitude * 180 / Math.PI;
  const polarDeg = Math.min(89, Math.max(1, 90 - altDeg));
  return { azimuth: azDeg, altitude: altDeg, polar: polarDeg };
}

// ── Colour / intensity helpers (driven by real altitude) ──────────────────
function altitudeToSunColor(altDeg) {
  if (altDeg < -6) return "rgba(15,  15,  50,  255)";
  if (altDeg < 0) return "rgba(60,  30,  80,  255)";
  if (altDeg < 5) return "rgba(255, 100,  40,  255)";
  if (altDeg < 15) return "rgba(255, 170,  80,  255)";
  if (altDeg < 30) return "rgba(255, 220, 150,  255)";
  return "rgba(255, 255, 240,  255)";
}

function altitudeToAmbientColor(altDeg) {
  if (altDeg < -6) return "rgba(10,  10,  35,  255)";
  if (altDeg < 0) return "rgba(40,  30,  70,  255)";
  if (altDeg < 10) return "rgba(100, 80,  120, 255)";
  if (altDeg < 30) return "rgba(100, 130, 190, 255)";
  return "rgba(120, 150, 200, 255)";
}

function altitudeToIntensity(altDeg) {
  if (altDeg < 0) return 0.05;
  if (altDeg < 5) return 0.25;
  if (altDeg < 15) return 0.50;
  if (altDeg < 35) return 0.72;
  return 0.95;
}

function altitudeToAmbientIntensity(altDeg) {
  if (altDeg < 0) return 0.10;
  if (altDeg < 10) return 0.25;
  return 0.40;
}

function getSunPhase(altDeg, hour) {
  if (altDeg < -6) return { label: "Night", icon: "🌙" };
  if (altDeg < 0) return { label: "Civil Twilight", icon: "🌆" };
  if (hour < 10) return { label: "Morning", icon: "🌤" };
  if (hour < 13) return { label: "Midday", icon: "☀️" };
  if (hour < 16) return { label: "Afternoon", icon: "🌤" };
  if (hour < 18) return { label: "Dusk", icon: "🌇" };
  return { label: "Evening", icon: "🌇" };
}

function hourToLabel(h) {
  const hh = Math.floor(h);
  const mm = h % 1 === 0.5 ? "30" : "00";
  const period = hh < 12 ? "AM" : "PM";
  const display = hh > 12 ? hh - 12 : hh === 0 ? 12 : hh;
  return `${display}:${mm} ${period}`;
}

// ── Geolocation helper ───────────────────────────────────────────────────────
function getUserLocation(defaultLat, defaultLng) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ lat: defaultLat, lng: defaultLng });
      return;
    }
    const timer = setTimeout(() => resolve({ lat: defaultLat, lng: defaultLng }), 6000);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        clearTimeout(timer);
        resolve({ lat: coords.latitude, lng: coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve({ lat: defaultLat, lng: defaultLng });
      },
      { enableHighAccuracy: true, timeout: 6000 }
    );
  });
}

// ── Component ──────────────────────────────────────────────────────────────
export default function ShadowAnalysis() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const sunCalcRef = useRef(null);

  const [hour, setHour] = useState(9);
  const [doy, setDoy] = useState(172);   // summer solstice default
  const [mapLoaded, setMapLoaded] = useState(false);
  const [tokenMissing, setTokenMissing] = useState(false);
  const [sunPos, setSunPos] = useState({ azimuth: 180, altitude: 60, polar: 30 });
  const [sunCalcReady, setSunCalcReady] = useState(false);
  const [location, setLocation] = useState({ lat: DEFAULT_LAT, lng: DEFAULT_LNG });
  const locationRef = useRef({ lat: DEFAULT_LAT, lng: DEFAULT_LNG });

  // ── Load SunCalc eagerly ─────────────────────────────────────────────────
  useEffect(() => {
    loadSunCalc().then(sc => {
      sunCalcRef.current = sc;
      setSunCalcReady(true);
    });
  }, []);

  // ── Recalculate sun position whenever hour or doy changes ────────────────
  const recalcSun = useCallback((h, d, sc) => {
    const dt = buildDateTime(d, h);
    const raw = sc.getPosition(dt, locationRef.current.lat, locationRef.current.lng);
    return sunCalcToMapbox(raw);
  }, []);

  useEffect(() => {
    if (!sunCalcRef.current) return;
    const pos = recalcSun(hour, doy, sunCalcRef.current);
    setSunPos(pos);
  }, [hour, doy, sunCalcReady, location, recalcSun]);

  // ── Apply lights to map whenever sunPos changes ──────────────────────────
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;

    mapRef.current.setLights([
      {
        id: "sun",
        type: "directional",
        properties: {
          color: altitudeToSunColor(sunPos.altitude),
          intensity: altitudeToIntensity(sunPos.altitude),
          direction: [sunPos.azimuth, sunPos.polar],
          "cast-shadows": true,
          "shadow-intensity": sunPos.altitude > 0 ? 0.85 : 0.0,
        },
      },
      {
        id: "sky-fill",
        type: "ambient",
        properties: {
          color: altitudeToAmbientColor(sunPos.altitude),
          intensity: altitudeToAmbientIntensity(sunPos.altitude),
        },
      },
    ]);
  }, [sunPos, mapLoaded]);

  function initMap(loc) {
    const mapboxgl = window.mapboxgl;
    mapboxgl.accessToken = MAPBOX_TOKEN;

    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/standard",
      center: [loc.lng, loc.lat],
      zoom: 15.8,
      pitch: 62,
      bearing: -20,
      antialias: true,
    });

    map.on("style.load", () => {
      // Initial lights (will be overwritten by useEffect once mapLoaded=true)
      map.setLights([
        {
          id: "sun", type: "directional",
          properties: {
            color: "rgba(255,255,240,255)", intensity: 0.9,
            direction: [180, 30],
            "cast-shadows": true, "shadow-intensity": 0.85,
          },
        },
        {
          id: "sky-fill", type: "ambient",
          properties: { color: "rgba(120,150,200,255)", intensity: 0.4 },
        },
      ]);

      map.addLayer({
        id: "3d-buildings",
        slot: "middle",
        source: "composite",
        "source-layer": "building",
        filter: ["==", "extrude", "true"],
        type: "fill-extrusion",
        minzoom: 12,
        paint: {
          "fill-extrusion-color": [
            "interpolate", ["linear"], ["get", "height"],
            0, "#c8b8a2", 30, "#b5a48e", 80, "#a09080", 200, "#8a8090",
          ],
          "fill-extrusion-height": [
            "interpolate", ["linear"], ["zoom"], 12, 0, 12.05, ["get", "height"],
          ],
          "fill-extrusion-base": [
            "interpolate", ["linear"], ["zoom"], 12, 0, 12.05, ["get", "min_height"],
          ],
          "fill-extrusion-opacity": 0.95,
          "fill-extrusion-flood-light-color": "#f0e8d0",
          "fill-extrusion-flood-light-intensity": 0.15,
          "fill-extrusion-flood-light-ground-radius": 8,
          "fill-extrusion-ambient-occlusion-intensity": 0.4,
          "fill-extrusion-ambient-occlusion-radius": 4,
        },
      });

      mapRef.current = map;
      setMapLoaded(true);
    });
  }

  // ── Bootstrap Mapbox GL JS v3 ────────────────────────────────────────────
  useEffect(() => {
    if (MAPBOX_TOKEN === "YOUR_MAPBOX_ACCESS_TOKEN_HERE") {
      setTokenMissing(true);
      return;
    }

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css";
    document.head.appendChild(link);

    const script = document.createElement("script");
    script.src = "https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js";
    script.onload = async () => {
      const loc = await getUserLocation(DEFAULT_LAT, DEFAULT_LNG);
      locationRef.current = loc;
      setLocation(loc);
      initMap(loc);
    };
    document.head.appendChild(script);

    return () => { if (mapRef.current) mapRef.current.remove(); };
  }, []);



  // ── Derived UI ────────────────────────────────────────────────────────────
  const phase = getSunPhase(sunPos.altitude, hour);
  const season = formatSeasonLabel(doy);
  const dateStr = formatDayOfYear(doy);

  // Sun dot in arc visualiser: clamp altitude 0–90 for display
  const displayAlt = Math.max(0, Math.min(90, sunPos.altitude));
  const arcAz = ((sunPos.azimuth - 90 + 360) % 360);   // shift so E=0 for display
  const sunX = Math.min(95, Math.max(5, 20 + (arcAz / 180) * 60));
  const sunY = 85 - (displayAlt / 90) * 72;
  const isBelowHorizon = sunPos.altitude < 0;

  // ── Token screen ──────────────────────────────────────────────────────────
  if (tokenMissing) {
    return (
      <div style={{
        width: "100%", height: "100vh", background: "#0a0a0f",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'Courier New',monospace", color: "#f59e0b",
        flexDirection: "column", gap: "16px", padding: "24px", textAlign: "center",
      }}>
        <div style={{ fontSize: "40px" }}>🗝️</div>
        <div style={{ fontSize: "18px", fontWeight: "bold", letterSpacing: "0.1em" }}>
          MAPBOX TOKEN REQUIRED
        </div>
        <div style={{
          background: "#1a1a0a", border: "1px solid #f59e0b44", borderRadius: "8px",
          padding: "16px 24px", fontSize: "13px", lineHeight: "1.8",
          color: "#d1d5db", maxWidth: "520px",
        }}>
          Replace <span style={{ color: "#f59e0b" }}>`YOUR_MAPBOX_ACCESS_TOKEN_HERE`</span> with
          your free public token from <span style={{ color: "#60a5fa" }}>mapbox.com</span>
        </div>
      </div>
    );
  }

  // ── Main ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      width: "100%", height: "100vh", position: "relative",
      background: "#0a0a0f", fontFamily: "'DM Mono','Courier New',monospace",
    }}>
      <div ref={mapContainer} style={{ width: "100%", height: "100%" }} />

      {/* Title */}
      <div style={{
        position: "absolute", top: "20px", left: "20px",
        background: "rgba(10,10,15,0.88)", backdropFilter: "blur(12px)",
        border: "1px solid rgba(245,158,11,0.35)", borderRadius: "4px",
        padding: "10px 16px", color: "#f59e0b",
        letterSpacing: "0.13em", fontSize: "11px", fontWeight: "600", textTransform: "uppercase",
      }}>
        ◈ Shadow Analysis — Your Location
      </div>

      {/* v3 badge */}
      <div style={{
        position: "absolute", top: "20px", right: "20px",
        background: "rgba(10,10,15,0.88)", backdropFilter: "blur(12px)",
        border: "1px solid rgba(96,165,250,0.3)", borderRadius: "4px",
        padding: "6px 12px", color: "#60a5fa",
        letterSpacing: "0.1em", fontSize: "10px", fontWeight: "600",
      }}>
        GL JS v3 · SunCalc · castShadows ✓
      </div>

      {/* Control panel */}
      <div style={{
        position: "absolute", bottom: "20px", left: "50%", transform: "translateX(-50%)",
        width: "min(580px, calc(100vw - 32px))",
        background: "rgba(8,8,14,0.94)", backdropFilter: "blur(16px)",
        border: "1px solid rgba(245,158,11,0.2)", borderRadius: "12px",
        padding: "18px 22px",
        boxShadow: "0 8px 40px rgba(0,0,0,0.65)",
      }}>

        {/* Sun arc */}
        <div style={{ position: "relative", height: "58px", marginBottom: "14px" }}>
          <div style={{
            position: "absolute", inset: 0,
            background: "linear-gradient(to bottom, rgba(245,158,11,0.05), transparent)",
            borderBottom: "1px solid rgba(245,158,11,0.12)", borderRadius: "4px",
          }} />
          <span style={{
            position: "absolute", bottom: "4px", left: "8px",
            fontSize: "9px", color: "rgba(245,158,11,0.3)", letterSpacing: "0.1em",
          }}>HORIZON</span>
          <span style={{
            position: "absolute", bottom: "4px", right: "8px",
            fontSize: "9px", color: "rgba(255,255,255,0.15)", letterSpacing: "0.08em",
          }}>
            {`LAT ${location.lat.toFixed(3)}° · LNG ${location.lng.toFixed(3)}°`}
          </span>

          <svg
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
            viewBox="0 0 100 100" preserveAspectRatio="none"
          >
            <path
              d="M 20 95 Q 50 5 80 95"
              fill="none"
              stroke="rgba(245,158,11,0.15)"
              strokeWidth="1.5"
              strokeDasharray="2.5 3.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {/* Sun dot */}
          <div style={{
            position: "absolute",
            left: `${sunX}%`, top: isBelowHorizon ? "92%" : `${sunY}%`,
            transform: "translate(-50%,-50%)",
            width: isBelowHorizon ? "10px" : "16px",
            height: isBelowHorizon ? "10px" : "16px",
            background: isBelowHorizon ? "#475569"
              : sunPos.altitude < 5 ? "#f97316"
                : sunPos.altitude < 20 ? "#fb923c"
                  : "#f59e0b",
            borderRadius: "50%",
            opacity: isBelowHorizon ? 0.35 : 1,
            boxShadow: isBelowHorizon ? "none"
              : sunPos.altitude < 10
                ? "0 0 8px #f97316, 0 0 18px rgba(249,115,22,0.45)"
                : "0 0 10px #f59e0b, 0 0 22px rgba(245,158,11,0.5)",
            transition: "left 0.2s ease, top 0.2s ease, background 0.4s ease, width 0.2s, height 0.2s",
            zIndex: 2,
          }} />
        </div>

        {/* Date + time display row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: "10px" }}>
              <div style={{ fontSize: "26px", color: "#f8fafc", fontWeight: "600", letterSpacing: "0.04em" }}>
                {hourToLabel(hour)}
              </div>
              <div style={{ fontSize: "14px", color: "rgba(255,255,255,0.45)", fontWeight: "400" }}>
                {dateStr}
              </div>
            </div>
            <div style={{ fontSize: "10px", color: "rgba(245,158,11,0.65)", letterSpacing: "0.14em", marginTop: "3px" }}>
              {phase.icon} {phase.label.toUpperCase()}
              &nbsp;&nbsp;·&nbsp;&nbsp;
              {season.icon} {season.label.toUpperCase()}
            </div>
          </div>

          <div style={{ display: "flex", gap: "14px" }}>
            {[
              { label: "AZIMUTH", value: `${Math.round(sunPos.azimuth)}°`, color: "#60a5fa" },
              { label: "ALTITUDE", value: `${sunPos.altitude.toFixed(1)}°`, color: sunPos.altitude < 0 ? "#f87171" : "#34d399" },
              { label: "POLAR", value: `${Math.round(sunPos.polar)}°`, color: "#a78bfa" },
              { label: "SHADOW →", value: `${Math.round((sunPos.azimuth + 180) % 360)}°`, color: "#f472b6" },
            ].map(s => (
              <div key={s.label} style={{ textAlign: "right" }}>
                <div style={{ fontSize: "8px", color: "rgba(255,255,255,0.25)", letterSpacing: "0.08em", marginBottom: "3px" }}>
                  {s.label}
                </div>
                <div style={{ fontSize: "14px", color: s.color, fontWeight: "500" }}>
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        <style>{`
          .astro-slider {
            -webkit-appearance:none; appearance:none;
            width:100%; height:3px; border-radius:2px; outline:none; cursor:pointer;
          }
          .astro-slider.time {
            background: linear-gradient(
              to right,
              #f59e0b ${((hour - 0) / 24) * 100}%,
              rgba(255,255,255,0.08) ${((hour - 0) / 24) * 100}%
            );
          }
          .astro-slider.date {
            background: linear-gradient(
              to right,
              #34d399 ${((doy - 1) / 364) * 100}%,
              rgba(255,255,255,0.08) ${((doy - 1) / 364) * 100}%
            );
          }
          .astro-slider::-webkit-slider-thumb {
            -webkit-appearance:none;
            width:18px; height:18px; border-radius:50%;
            box-shadow:0 0 0 3px rgba(255,255,255,0.1), 0 0 10px rgba(255,255,255,0.2);
            cursor:grab; transition:box-shadow 0.15s;
          }
          .astro-slider.time::-webkit-slider-thumb { background:#f59e0b; }
          .astro-slider.date::-webkit-slider-thumb { background:#34d399; }
          .astro-slider::-webkit-slider-thumb:active { cursor:grabbing; }
          .astro-slider::-moz-range-thumb {
            width:18px; height:18px; border-radius:50%; border:none; cursor:grab;
          }
          .astro-slider.time::-moz-range-thumb { background:#f59e0b; }
          .astro-slider.date::-moz-range-thumb { background:#34d399; }
        `}</style>

        {/* Time slider */}
        <div style={{ marginBottom: "12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "5px" }}>
            <span style={{ fontSize: "9px", color: "rgba(245,158,11,0.6)", letterSpacing: "0.12em" }}>
              ● TIME OF DAY
            </span>
            <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.2)", letterSpacing: "0.08em" }}>
              0:00 AM — 11:30 PM
            </span>
          </div>
          <input
            type="range" className="astro-slider time"
            min={0} max={23.5} step={0.5}
            value={hour}
            onChange={e => setHour(parseFloat(e.target.value))}
          />
          <div style={{
            display: "flex", justifyContent: "space-between", marginTop: "4px",
            fontSize: "8px", color: "rgba(255,255,255,0.18)", letterSpacing: "0.06em"
          }}>
            <span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span>
          </div>
        </div>

        {/* Date slider */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "5px" }}>
            <span style={{ fontSize: "9px", color: "rgba(52,211,153,0.7)", letterSpacing: "0.12em" }}>
              ● DAY OF YEAR
            </span>
            <span style={{ fontSize: "9px", color: "rgba(255,255,255,0.2)", letterSpacing: "0.08em" }}>
              Day {doy} of 365
            </span>
          </div>
          <input
            type="range" className="astro-slider date"
            min={1} max={365} step={1}
            value={doy}
            onChange={e => setDoy(parseInt(e.target.value))}
          />
          <div style={{
            display: "flex", justifyContent: "space-between", marginTop: "4px",
            fontSize: "8px", color: "rgba(255,255,255,0.18)", letterSpacing: "0.06em"
          }}>
            <span>Jan 1</span><span>Mar 20 ❄→🌸</span><span>Jun 21 ☀️</span><span>Sep 22 🍂</span><span>Dec 31</span>
          </div>
        </div>

        {/* Footer legend */}
        <div style={{
          marginTop: "12px", paddingTop: "10px",
          borderTop: "1px solid rgba(255,255,255,0.05)",
          display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "center",
        }}>
          {[
            { dot: "#f59e0b", text: "Sun (DirectionalLight)" },
            { dot: "#60a5fa", text: "Sky (AmbientLight)" },
            { dot: "#1e293b", text: "Cast shadow on ground" },
            { dot: "#34d399", text: "SunCalc astronomical pos" },
          ].map(l => (
            <div key={l.text} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
              <div style={{
                width: "7px", height: "7px", borderRadius: "50%",
                background: l.dot, flexShrink: 0, boxShadow: `0 0 4px ${l.dot}88`
              }} />
              <span style={{ fontSize: "8px", color: "rgba(255,255,255,0.28)", letterSpacing: "0.07em" }}>
                {l.text}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Loading overlay */}
      {!mapLoaded && (
        <div style={{
          position: "absolute", inset: 0, background: "#0a0a0f",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: "12px", color: "#f59e0b", fontSize: "12px", letterSpacing: "0.2em",
        }}>
          <div>LOADING SUNCALC + MAPBOX GL JS v3…</div>
          <div style={{ fontSize: "9px", color: "rgba(255,255,255,0.3)" }}>
            {location.lat.toFixed(4)}°N, {location.lng.toFixed(4)}°E
          </div>
        </div>
      )}
    </div>
  );
}