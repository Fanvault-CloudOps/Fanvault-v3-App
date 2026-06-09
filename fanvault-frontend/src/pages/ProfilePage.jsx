import { useState } from 'react';
import { User, MapPin, Bell, Plus, Trash2, Check, Edit3 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { userAPI } from '../api/client';
import toast from 'react-hot-toast';
import './ProfilePage.css';

export default function ProfilePage() {
  const { user, profile, refreshProfile } = useAuth();
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addingAddr, setAddingAddr] = useState(false);
  const [form, setForm] = useState({
    firstName: profile?.firstName || '',
    lastName: profile?.lastName || '',
    phone: profile?.phone || '',
  });
  const [newAddr, setNewAddr] = useState({ line1: '', line2: '', city: '', state: '', postalCode: '', country: 'India', isDefault: false });

  const handleSaveProfile = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await userAPI.updateProfile(form);
      await refreshProfile();
      toast.success('Profile updated!');
      setEditMode(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  const handleAddAddress = async (e) => {
    e.preventDefault();
    try {
      await userAPI.addAddress(newAddr);
      await refreshProfile();
      toast.success('Address added!');
      setAddingAddr(false);
      setNewAddr({ line1: '', line2: '', city: '', state: '', postalCode: '', country: 'India', isDefault: false });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to add address');
    }
  };

  const handleRemoveAddress = async (addrId) => {
    if (!window.confirm('Remove this address?')) return;
    try {
      await userAPI.removeAddress(addrId);
      await refreshProfile();
      toast.success('Address removed');
    } catch (err) {
      toast.error('Failed to remove address');
    }
  };

  return (
    <div className="page">
      <div className="container profile-container">
        <h1 style={{ marginBottom: 28 }}>My Profile</h1>

        <div className="profile-layout">
          {/* Profile card */}
          <div className="profile-sidebar">
            <div className="card card-body profile-avatar-card">
              <div className="profile-avatar-large">{user?.email?.charAt(0)?.toUpperCase()}</div>
              <p className="profile-email">{user?.email}</p>
              <span className={`badge ${user?.role === 'admin' ? 'badge-amber' : 'badge-green'}`}>{user?.role}</span>
              {profile?.firstName && <p className="profile-name">{profile.firstName} {profile.lastName}</p>}
            </div>
          </div>

          {/* Details */}
          <div className="profile-main">
            {/* Personal info */}
            <div className="card card-body profile-section">
              <div className="section-header-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <User size={18} color="var(--brand)" />
                  <h3>Personal Information</h3>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditMode(!editMode)}>
                  <Edit3 size={14} /> {editMode ? 'Cancel' : 'Edit'}
                </button>
              </div>

              {editMode ? (
                <form onSubmit={handleSaveProfile} className="profile-form">
                  <div className="form-grid-2">
                    <div className="form-group">
                      <label className="form-label">First Name</label>
                      <input className="form-input" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} placeholder="John" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Last Name</label>
                      <input className="form-input" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} placeholder="Doe" />
                    </div>
                    <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                      <label className="form-label">Phone</label>
                      <input className="form-input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+91 9876543210" />
                    </div>
                  </div>
                  <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
                    {saving ? 'Saving...' : <><Check size={14} /> Save Changes</>}
                  </button>
                </form>
              ) : (
                <div className="profile-info-grid">
                  <div className="info-item"><span className="info-label">First Name</span><span className="info-value">{profile?.firstName || '—'}</span></div>
                  <div className="info-item"><span className="info-label">Last Name</span><span className="info-value">{profile?.lastName || '—'}</span></div>
                  <div className="info-item"><span className="info-label">Email</span><span className="info-value">{user?.email}</span></div>
                  <div className="info-item"><span className="info-label">Phone</span><span className="info-value">{profile?.phone || '—'}</span></div>
                </div>
              )}
            </div>

            {/* Addresses */}
            <div className="card card-body profile-section">
              <div className="section-header-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <MapPin size={18} color="var(--brand)" />
                  <h3>Saved Addresses</h3>
                </div>
                <button className="btn btn-primary btn-sm" onClick={() => setAddingAddr(!addingAddr)}>
                  <Plus size={14} /> Add Address
                </button>
              </div>

              {addingAddr && (
                <form onSubmit={handleAddAddress} className="add-addr-form">
                  <div className="form-grid-2">
                    <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                      <label className="form-label">Address Line 1 *</label>
                      <input className="form-input" value={newAddr.line1} onChange={(e) => setNewAddr({ ...newAddr, line1: e.target.value })} required />
                    </div>
                    <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                      <label className="form-label">Address Line 2</label>
                      <input className="form-input" value={newAddr.line2} onChange={(e) => setNewAddr({ ...newAddr, line2: e.target.value })} />
                    </div>
                    <div className="form-group"><label className="form-label">City *</label><input className="form-input" value={newAddr.city} onChange={(e) => setNewAddr({ ...newAddr, city: e.target.value })} required /></div>
                    <div className="form-group"><label className="form-label">State *</label><input className="form-input" value={newAddr.state} onChange={(e) => setNewAddr({ ...newAddr, state: e.target.value })} required /></div>
                    <div className="form-group"><label className="form-label">PIN Code *</label><input className="form-input" value={newAddr.postalCode} onChange={(e) => setNewAddr({ ...newAddr, postalCode: e.target.value })} required /></div>
                    <div className="form-group"><label className="form-label">Country</label><input className="form-input" value={newAddr.country} onChange={(e) => setNewAddr({ ...newAddr, country: e.target.value })} /></div>
                  </div>
                  <label className="checkbox-label">
                    <input type="checkbox" checked={newAddr.isDefault} onChange={(e) => setNewAddr({ ...newAddr, isDefault: e.target.checked })} />
                    Set as default address
                  </label>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button type="submit" className="btn btn-primary btn-sm"><Check size={14} /> Save Address</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAddingAddr(false)}>Cancel</button>
                  </div>
                </form>
              )}

              {!profile?.addresses?.length ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 14, margin: 0 }}>No addresses saved yet.</p>
              ) : (
                <div className="addresses-list">
                  {profile.addresses.map((addr) => (
                    <div key={addr._id || addr.addressId} className={`address-card ${addr.isDefault ? 'default' : ''}`}>
                      <div className="address-info">
                        {addr.isDefault && <span className="badge badge-green" style={{ marginBottom: 6 }}>Default</span>}
                        <p>{addr.line1}{addr.line2 ? `, ${addr.line2}` : ''}</p>
                        <p>{addr.city}, {addr.state} – {addr.postalCode}</p>
                        <p>{addr.country}</p>
                      </div>
                      <button className="btn btn-ghost btn-sm remove-addr-btn" onClick={() => handleRemoveAddress(addr._id || addr.addressId)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Preferences */}
            <div className="card card-body profile-section">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <Bell size={18} color="var(--brand)" />
                <h3>Preferences</h3>
              </div>
              <div className="pref-items">
                <label className="checkbox-label">
                  <input type="checkbox" defaultChecked={profile?.preferences?.newsletter} /> Newsletter & Offers
                </label>
                <label className="checkbox-label">
                  <input type="checkbox" defaultChecked={profile?.preferences?.smsAlerts} /> SMS Alerts
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
