'use client';

import { useState, useEffect, useRef } from 'react';
import { profilesApi, Profile, CreateProfileDTO } from '@/lib/api';
import ProfileForm from '@/components/admin/ProfileForm';

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadProfiles();
  }, []);

  const loadProfiles = async () => {
    try {
      const data = await profilesApi.getAll({ includeDisabled: true });
      setProfiles(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profiles');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreate = async (data: CreateProfileDTO) => {
    try {
      await profilesApi.create(data);
      await loadProfiles();
      setShowForm(false);
    } catch (err) {
      throw err;
    }
  };

  const handleUpdate = async (data: CreateProfileDTO) => {
    if (!editingProfile) return;
    try {
      await profilesApi.update(editingProfile.id, data);
      await loadProfiles();
      setEditingProfile(null);
      setShowForm(false);
    } catch (err) {
      throw err;
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this profile?')) return;
    try {
      await profilesApi.delete(id);
      await loadProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete profile');
    }
  };

  const handleToggleDisabled = async (profile: Profile) => {
    try {
      await profilesApi.update(profile.id, { disabled: !profile.disabled });
      await loadProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile status');
    }
  };

  const openCreateForm = () => {
    setEditingProfile(null);
    setShowForm(true);
  };

  const openEditForm = (profile: Profile) => {
    setEditingProfile(profile);
    setShowForm(true);
  };

  const closeForm = () => {
    setEditingProfile(null);
    setShowForm(false);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      setError('Please upload a PDF file');
      return;
    }

    setIsUploading(true);
    setUploadProgress('Uploading PDF...');
    setError('');

    try {
      setUploadProgress('Extracting profile information with AI...');
      const profile = await profilesApi.uploadResume(file);
      await loadProfiles();
      setUploadProgress('');
      // Open edit form with the extracted profile so user can review/edit
      setEditingProfile(profile);
      setShowForm(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to extract profile from PDF');
    } finally {
      setIsUploading(false);
      setUploadProgress('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const triggerFileUpload = () => {
    fileInputRef.current?.click();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Profiles</h1>
        <div className="flex gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            onClick={triggerFileUpload}
            disabled={isUploading}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isUploading ? (
              <>
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Extracting...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                Upload Resume PDF
              </>
            )}
          </button>
          <button
            onClick={openCreateForm}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
          >
            Add Manually
          </button>
        </div>
      </div>

      {uploadProgress && (
        <div className="bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded-md mb-4 flex items-center gap-2">
          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          {uploadProgress}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md mb-4">
          {error}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold">
                  {editingProfile ? 'Edit Profile' : 'Create Profile'}
                </h2>
                <button
                  onClick={closeForm}
                  className="text-gray-500 hover:text-gray-700"
                >
                  <svg
                    className="w-6 h-6"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
              <ProfileForm
                initialData={editingProfile || undefined}
                onSubmit={editingProfile ? handleUpdate : handleCreate}
                onCancel={closeForm}
              />
            </div>
          </div>
        </div>
      )}

      {profiles.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg shadow">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">No profiles</h3>
          <p className="mt-1 text-sm text-gray-500">
            Get started by creating a new profile.
          </p>
          <div className="mt-6">
            <button
              onClick={openCreateForm}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Add Profile
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {profiles.map((profile) => (
            <div
              key={profile.id}
              className="bg-white rounded-lg shadow-md p-6 hover:shadow-lg transition-shadow"
            >
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    {profile.name}
                  </h3>
                  {profile.disabled && (
                    <span className="inline-block mt-1 px-2 py-0.5 bg-gray-200 text-gray-700 text-xs rounded">
                      Disabled
                    </span>
                  )}
                </div>
              </div>

              <div className="flex justify-end space-x-2 pt-4 border-t">
                <button
                  onClick={() => openEditForm(profile)}
                  className="px-3 py-1 text-sm text-blue-600 hover:bg-blue-50 rounded"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleToggleDisabled(profile)}
                  className="px-3 py-1 text-sm text-amber-700 hover:bg-amber-50 rounded"
                >
                  {profile.disabled ? 'Enable' : 'Disable'}
                </button>
                <button
                  onClick={() => handleDelete(profile.id)}
                  className="px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
