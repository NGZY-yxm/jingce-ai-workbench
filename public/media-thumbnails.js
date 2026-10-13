export const thumbnailUrl = source => source + (source.includes('?') ? '&' : '?') + 'thumbnail=1';
export const assetThumbnailUrl = id => thumbnailUrl('/api/assets/' + encodeURIComponent(id));
