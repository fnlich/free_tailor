export interface Group {
  id: string;
  /** The account this group belongs to. Absent on rows written before v2. */
  ownerId?: string;
  name: string;
  profileIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateGroupDTO {
  name?: string;
  profileIds?: string[];
}
