import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Upload, X, ArrowLeft, Loader, Sparkles } from 'lucide-react';
import { adminAPI } from '../../api/client';
import toast from 'react-hot-toast';

const CATEGORIES    = ['clothing', 'accessories', 'shoes', 'ornaments'];
const FRANCHISE_TYPES = ['sports', 'movie', 'show'];

const EMPTY = {
  name: '', description: '', price: '', comparePrice: '', category: 'clothing',
  franchise: '', franchiseType: 'sports', sku: '', stock: '0',
  sizes: '', colors: '', tags: '', images: [],
};

export default function AdminProductForm() {
  const { productId } = useParams();
  const isEdit      = !!productId;
  const navigate    = useNavigate();
  const fileRef     = useRef();
  const [form, setForm]           = useState(EMPTY);
  const [uploading, setUploading] = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [loading,   setLoading]   = useState(isEdit);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!isEdit) return;
    adminAPI.getProduct(productId)
      .then(({ data }) => {
        const p = data.product;
        setForm({
          name:          p.name         || '',
          description:   p.description  || '',
          price:         p.price        ?? '',
          comparePrice:  p.comparePrice ?? '',
          category:      p.category     || 'clothing',
          franchise:     p.franchise    || '',
          franchiseType: p.franchiseType|| 'sports',
          sku:           p.sku          || '',
          stock:         p.stock        ?? 0,
          sizes:         (p.sizes  || []).join(', '),
          colors:        (p.colors || []).join(', '),
          tags:          (p.tags   || []).join(', '),
          images:        p.images  || [],
        });
      })
      .catch(() => toast.error('Failed to load product'))
      .finally(() => setLoading(false));
  }, [productId, isEdit]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleImageChange = async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setUploading(true);
    try {
      const uploaded = [];
      for (const file of files) {
        if (file.size > 5 * 1024 * 1024) { toast.error(`${file.name} exceeds 5 MB`); continue; }
        const { data } = await adminAPI.getUploadUrl({
          fileType: file.type,
          fileSize: file.size,
          folder:   'products',
        });
        await fetch(data.uploadUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type },
        });
        // Build preview URL from key (CloudFront URL is returned on product fetch; here use key directly)
        uploaded.push({ key: data.key, preview: URL.createObjectURL(file) });
      }
      setForm(f => ({
        ...f,
        images: [...f.images, ...uploaded.map(u => u.key)],
      }));
      toast.success(`${uploaded.length} image(s) uploaded`);
    } catch (err) {
      toast.error('Image upload failed: ' + err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeImage = (idx) => setForm(f => ({ ...f, images: f.images.filter((_, i) => i !== idx) }));

  const handleGenerateMetadata = async () => {
    const imageKey = form.images[0];
    if (!imageKey) return;
    setGenerating(true);
    try {
      const { data } = await adminAPI.generateMetadata({ imageKey });
      if (!data.success) throw new Error(data.error || 'Generation failed');
      const { title, description, tags } = data.data;
      setForm(f => ({
        ...f,
        name:        title       || f.name,
        description: description || f.description,
        tags:        Array.isArray(tags) ? tags.join(', ') : f.tags,
      }));
      toast.success(`Metadata generated via ${data.provider} in ${data.latencyMs}ms`);
    } catch (err) {
      const msg = err.response?.data?.message || err.response?.data?.error || err.message || 'AI generation failed';
      toast.error(msg);
    } finally {
      setGenerating(false);
    }
  };

  const splitArr = (str) => str.split(',').map(s => s.trim()).filter(Boolean);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        name:          form.name,
        description:   form.description,
        price:         Number(form.price),
        comparePrice:  form.comparePrice ? Number(form.comparePrice) : null,
        category:      form.category,
        franchise:     form.franchise,
        franchiseType: form.franchiseType,
        sku:           form.sku,
        stock:         Number(form.stock),
        sizes:         splitArr(form.sizes),
        colors:        splitArr(form.colors),
        tags:          splitArr(form.tags),
        images:        form.images,
      };
      if (isEdit) {
        await adminAPI.updateProduct(productId, payload);
        toast.success('Product updated');
      } else {
        await adminAPI.createProduct(payload);
        toast.success('Product created');
      }
      navigate('/admin/products');
    } catch (err) {
      const msg = err.response?.data?.error || err.response?.data?.errors?.[0]?.msg || 'Save failed';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;

  return (
    <div className="admin-page">
      <div className="admin-page-header">
        <div>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/products')} style={{ marginBottom: 6 }}>
            <ArrowLeft size={14} /> Back to Products
          </button>
          <h1>{isEdit ? 'Edit Product' : 'New Product'}</h1>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="admin-card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginBottom: 18, fontSize: '1rem' }}>Product Images</h3>
          <div
            className="image-upload-area"
            onClick={() => !uploading && fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              onChange={handleImageChange}
            />
            {uploading
              ? <><Loader size={28} className="image-upload-icon" style={{ animation: 'spin 1s linear infinite' }} /><p>Uploading...</p></>
              : <><Upload size={28} className="image-upload-icon" /><p>Click to upload images</p><small>JPEG, PNG, WebP, GIF — max 5 MB each</small></>
            }
          </div>

          {form.images.length > 0 && (
            <>
              <div className="image-preview-grid">
                {form.images.map((img, idx) => (
                  <div key={idx} className="image-preview-item">
                    <img src={img.startsWith('http') ? img : `/api/products/images/${img}`} alt={`img ${idx}`} />
                    <button type="button" className="image-preview-remove" onClick={() => removeImage(idx)}>×</button>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 16 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleGenerateMetadata}
                  disabled={generating}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  {generating
                    ? <><Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> Generating...</>
                    : <><Sparkles size={14} /> Generate metadata with AI</>
                  }
                </button>
                <small style={{ marginLeft: 10, color: '#9ca3af' }}>
                  Fills name, description, and tags from the first image
                </small>
              </div>
            </>
          )}
        </div>

        <div className="admin-card" style={{ marginBottom: 20 }}>
          <h3 style={{ marginBottom: 18, fontSize: '1rem' }}>Basic Information</h3>
          <div className="admin-form-grid">
            <div className="admin-form-group full-width">
              <label>Product Name *</label>
              <input required value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Mumbai Indians Jersey 2024" />
            </div>
            <div className="admin-form-group full-width">
              <label>Description *</label>
              <textarea required value={form.description} onChange={e => set('description', e.target.value)} placeholder="Describe the product..." />
            </div>
            <div className="admin-form-group">
              <label>Price (₹) *</label>
              <input required type="number" min="0" step="0.01" value={form.price} onChange={e => set('price', e.target.value)} />
            </div>
            <div className="admin-form-group">
              <label>Compare Price (₹)</label>
              <input type="number" min="0" step="0.01" value={form.comparePrice} onChange={e => set('comparePrice', e.target.value)} />
            </div>
            <div className="admin-form-group">
              <label>Category *</label>
              <select required value={form.category} onChange={e => set('category', e.target.value)}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="admin-form-group">
              <label>Franchise Type *</label>
              <select required value={form.franchiseType} onChange={e => set('franchiseType', e.target.value)}>
                {FRANCHISE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="admin-form-group">
              <label>Franchise *</label>
              <input required value={form.franchise} onChange={e => set('franchise', e.target.value)} placeholder="e.g. Mumbai Indians" />
            </div>
            <div className="admin-form-group">
              <label>SKU *</label>
              <input required value={form.sku} onChange={e => set('sku', e.target.value)} placeholder="e.g. MI-JERSEY-2024-S" />
            </div>
            <div className="admin-form-group">
              <label>Initial Stock *</label>
              <input required type="number" min="0" value={form.stock} onChange={e => set('stock', e.target.value)} />
            </div>
            <div className="admin-form-group">
              <label>Sizes</label>
              <input value={form.sizes} onChange={e => set('sizes', e.target.value)} placeholder="S, M, L, XL (comma separated)" />
            </div>
            <div className="admin-form-group">
              <label>Colors</label>
              <input value={form.colors} onChange={e => set('colors', e.target.value)} placeholder="Red, Blue (comma separated)" />
            </div>
            <div className="admin-form-group">
              <label>Tags</label>
              <input value={form.tags} onChange={e => set('tags', e.target.value)} placeholder="ipl, cricket, jersey (comma separated)" />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <button type="submit" className="btn btn-primary" disabled={saving || uploading}>
            {saving ? 'Saving...' : isEdit ? 'Update Product' : 'Create Product'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => navigate('/admin/products')}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
