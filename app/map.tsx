"use client";
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet.markercluster";
export interface Point {
  id: number;
  latitude: number;
  longitude: number;
  trade: string;
  address: string;
  city: string;
  state: string;
  stage: string;
  score: number;
  location_method: string;
}
export interface Center {
  lat: number;
  lng: number;
}
export default function PermitMap({
  points,
  center,
  radius,
  choosing,
  onChoose,
  onOpen,
}: {
  points: Point[];
  center: Center | null;
  radius: number;
  choosing: boolean;
  onChoose: (c: Center | null) => void;
  onOpen: (id: number) => void;
}) {
  const element = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null),
    markers = useRef<L.MarkerClusterGroup | null>(null),
    circle = useRef<L.Circle | null>(null),
    lastPoints = useRef(""),
    fitted = useRef(false);
  const callbacks = useRef({ choosing, onChoose, onOpen });
  callbacks.current = { choosing, onChoose, onOpen };
  const [error, setError] = useState("");
  useEffect(() => {
    if (!element.current) return;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const instance = L.map(element.current, {
      preferCanvas: true,
      zoomAnimation: !reduced,
      fadeAnimation: !reduced,
    }).setView([36.5, -98], 4);
    map.current = instance;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
      referrerPolicy: "strict-origin-when-cross-origin",
    })
      .on("tileerror", () =>
        setError(
          "Map background unavailable. Lead markers and the list remain available.",
        ),
      )
      .addTo(instance);
    markers.current = L.markerClusterGroup({
      animate: !reduced,
      showCoverageOnHover: false,
      maxClusterRadius: 45,
    });
    instance.addLayer(markers.current);
    instance.on("click", (event: L.LeafletMouseEvent) => {
      if (callbacks.current.choosing)
        callbacks.current.onChoose({
          lat: event.latlng.lat,
          lng: ((((event.latlng.lng + 180) % 360) + 360) % 360) - 180,
        });
    });
    return () => {
      instance.remove();
      map.current = null;
      markers.current = null;
      lastPoints.current = "";
      fitted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!map.current || !markers.current) return;
    const serialized = JSON.stringify(points);
    if (serialized === lastPoints.current) return;
    lastPoints.current = serialized;
    markers.current.clearLayers();
    for (const point of points) {
      const popup = document.createElement("div");
      popup.className = "permit-popup";
      const title = document.createElement("strong");
      title.textContent = point.address;
      popup.append(title);
      const description = document.createElement("p");
      description.textContent = `${point.city}, ${point.state} · ${point.trade} · ${point.stage} · Score ${point.score}`;
      popup.append(description);
      const method = document.createElement("small");
      method.textContent = point.location_method || "Published coordinates";
      popup.append(method);
      const button = document.createElement("button");
      button.className = "btn btn-primary";
      button.textContent = "View lead";
      button.onclick = () => callbacks.current.onOpen(point.id);
      popup.append(button);
      const category =
        point.trade === "Roofing"
          ? "roofing"
          : point.trade === "Tile"
            ? "tile"
            : "other";
      markers.current.addLayer(
        L.marker([point.latitude, point.longitude], {
          title: point.address,
          icon: L.divIcon({
            className: "permit-marker " + category,
            html: "",
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          }),
        }).bindPopup(popup),
      );
    }
    if (!fitted.current && points.length && !center) {
      map.current.fitBounds(
        points.map((p) => [p.latitude, p.longitude]),
        { padding: [30, 30], maxZoom: 15 },
      );
      fitted.current = true;
    }
  }, [points, center]);
  useEffect(() => {
    if (!map.current) return;
    if (circle.current) circle.current.remove();
    circle.current = null;
    if (center) {
      circle.current = L.circle(center, {
        radius: radius * 1609.344,
        color: "#b77a4d",
        weight: 2,
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(map.current);
      map.current.fitBounds(circle.current.getBounds(), {
        padding: [25, 25],
        maxZoom: 14,
      });
    }
  }, [center, radius]);
  useEffect(() => {
    if (choosing) element.current?.focus();
  }, [choosing]);
  function fit() {
    if (circle.current)
      map.current?.fitBounds(circle.current.getBounds(), {
        padding: [25, 25],
        maxZoom: 14,
      });
    else if (points.length)
      map.current?.fitBounds(
        points.map((p) => [p.latitude, p.longitude]),
        { padding: [30, 30], maxZoom: 15 },
      );
  }
  return (
    <>
      <div className="map-meta">
        <span>Approximate locations · verify before visiting</span>
        <button className="btn btn-outline-secondary" onClick={fit}>
          Fit results
        </button>
      </div>
      {error && <p role="status">{error}</p>}
      <div
        ref={element}
        id="opportunity-map"
        tabIndex={0}
        aria-label="Opportunity map. Use arrow keys to pan. Press Enter to choose the center when selecting a radius."
        onKeyDown={(e) => {
          if (e.key === "Enter" && choosing && map.current) {
            e.preventDefault();
            const c = map.current.getCenter();
            onChoose({
              lat: c.lat,
              lng: ((((c.lng + 180) % 360) + 360) % 360) - 180,
            });
          }
          if (e.key === "Escape" && choosing) onChoose(center);
        }}
      />
      <div className="map-legend">
        <span>
          <i className="dot roofing" />
          Roofing
        </span>
        <span>
          <i className="dot tile" />
          Tile
        </span>
        <span>
          <i className="dot other" />
          Other trades
        </span>
      </div>
    </>
  );
}
