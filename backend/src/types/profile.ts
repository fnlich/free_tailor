export interface Contact {
  phone: string;
  email: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  location: string;
}

export interface Experience {
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  location: string;
  description: string;
  achievements: string[];
  skills: string[];
}

export interface Strength {
  title: string;
  description: string;
}

export interface Education {
  degree: string;
  institution: string;
  startDate: string;
  endDate: string;
  location: string;
  gpa?: string;
  achievements?: string[];
}

export interface Certification {
  name: string;
  issuer: string;
  date: string;
  expiryDate?: string;
  credentialId?: string;
}

export interface ProfileSettings {
  resumePromptId?: string;
  analyzeJobPromptId?: string;
  coverLetterPromptId?: string;
  resumeFileNameTemplate?: string;
  coverLetterFileNameTemplate?: string;
  companyFolderNameTemplate?: string;
}

export interface Profile {
  id: string;
  name: string;
  title: string;
  totalYearsExperience?: number;
  preferredTemplate?: string;
  disabled?: boolean;
  profileSettings?: ProfileSettings;
  contact: Contact;
  summary: string;
  experience: Experience[];
  strengths: Strength[];
  skills: string[];
  education: Education[];
  certifications?: Certification[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateProfileDTO {
  name?: string;
  title?: string;
  totalYearsExperience?: number;
  preferredTemplate?: string;
  disabled?: boolean;
  profileSettings?: ProfileSettings;
  contact?: Partial<Contact>;
  summary?: string;
  experience?: Partial<Experience>[];
  strengths?: Partial<Strength>[];
  skills?: string[];
  education?: Partial<Education>[];
  certifications?: Certification[];
}
