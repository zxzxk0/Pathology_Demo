Fixes gene overlay placement by anchoring the 4096px static canvas to the transformed CosMx TiledImage bounds.
Deep-zoom coordinate conversion now uses the TiledImage's image/viewport transforms as well.
Performance mode remains hybrid: static overview + deep-zoom refresh.
