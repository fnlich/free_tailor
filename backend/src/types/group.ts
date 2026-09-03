export interface Group {
  id: string;
  name: string;
  profileIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateGroupDTO {
  name?: string;
  profileIds?: string[];
}
